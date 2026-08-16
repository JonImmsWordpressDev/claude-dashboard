'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { canonicalize, worktreeRoot, encodeProjectDir } = require('../lib/paths');
const { titleCase, displayBase } = require('../lib/names');
const { parsePorcelainV2 } = require('../lib/gitstatus');
const { activityBuckets } = require('../lib/history');

test('canonicalize strips trailing slash', () => {
  assert.equal(canonicalize('/a/b/'), '/a/b');
  assert.equal(canonicalize('/a/b'), '/a/b');
});

test('worktreeRoot folds .claude/worktrees paths into the repo root', () => {
  const r = worktreeRoot('/Users/x/Local Sites/stratawp/strataWP/.claude/worktrees/clever-bohr-7a38e0');
  assert.equal(r.root, '/Users/x/Local Sites/stratawp/strataWP');
  assert.equal(r.worktree, 'clever-bohr-7a38e0');
});

test('worktreeRoot passes normal paths through', () => {
  const r = worktreeRoot('/Users/x/AI Projects');
  assert.equal(r.root, '/Users/x/AI Projects');
  assert.equal(r.worktree, null);
});

test('worktreeRoot does not match a project literally named worktrees', () => {
  const r = worktreeRoot('/Users/x/worktrees/foo');
  assert.equal(r.root, '/Users/x/worktrees/foo');
  assert.equal(r.worktree, null);
});

test('encodeProjectDir matches Claude dir naming (slash, dot, space -> dash)', () => {
  assert.equal(encodeProjectDir('/Users/alex/AI Projects'), '-Users-alex-AI-Projects');
  assert.equal(
    encodeProjectDir('/Users/alex/Local Sites/north-ave'),
    '-Users-alex-Local-Sites-north-ave'
  );
});

test('displayBase walks up past generic WP scaffolding segments', () => {
  assert.equal(displayBase('/Users/x/Local Sites/jonimms/app/public'), 'jonimms');
  assert.equal(displayBase('/Users/x/Local Sites/north-ave'), 'north-ave');
});

test('titleCase keeps intentional casing, cleans dashes', () => {
  assert.equal(titleCase('north-ave'), 'North Ave');
  assert.equal(titleCase('strataWP'), 'strataWP'); // interior caps preserved
  assert.equal(titleCase('buildertrend_ideas'), 'Buildertrend Ideas');
});

test('parsePorcelainV2 extracts branch, ahead/behind, dirty, untracked', () => {
  const out = parsePorcelainV2([
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 x y file.txt',
    '2 R. N... 100644 100644 100644 x y R100 new.txt\told.txt',
    '? untracked.txt',
    '? another.txt',
    '',
  ].join('\n'));
  assert.equal(out.branch, 'main');
  assert.equal(out.ahead, 2);
  assert.equal(out.behind, 1);
  assert.equal(out.dirty, 2);
  assert.equal(out.untracked, 2);
});

test('parsePorcelainV2 handles no upstream (ahead/behind null)', () => {
  const out = parsePorcelainV2('# branch.oid abc\n# branch.head master\n');
  assert.equal(out.branch, 'master');
  assert.equal(out.ahead, null);
  assert.equal(out.behind, null);
});

test('activityBuckets puts today last and old prompts out of range', () => {
  const now = Date.now();
  const counts = activityBuckets([now, now - 3600_000, now - 20 * 86400_000], 14);
  assert.equal(counts.length, 14);
  assert.ok(counts[13] >= 1); // today
  assert.equal(counts.reduce((a, b) => a + b, 0) >= 1, true);
});

test('activityBuckets: yesterday lands in slot 12', () => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const yesterdayNoon = midnight.getTime() - 12 * 3600_000;
  const counts = activityBuckets([yesterdayNoon], 14);
  assert.equal(counts[12], 1);
});

const { newlyWaiting } = require('../lib/notify');

test('newlyWaiting: never fires on first poll (prev null)', () => {
  assert.deepEqual(newlyWaiting(null, new Map([['a', 'waiting']])), []);
});

test('newlyWaiting: fires on busy -> waiting', () => {
  const prev = new Map([['a', 'busy']]);
  const next = new Map([['a', 'waiting']]);
  assert.deepEqual(newlyWaiting(prev, next), ['a']);
});

test('newlyWaiting: no repeat while still waiting', () => {
  const prev = new Map([['a', 'waiting']]);
  const next = new Map([['a', 'waiting']]);
  assert.deepEqual(newlyWaiting(prev, next), []);
});

test('newlyWaiting: brand-new session already waiting fires', () => {
  const prev = new Map();
  const next = new Map([['b', 'waiting']]);
  assert.deepEqual(newlyWaiting(prev, next), ['b']);
});

test('newlyWaiting: busy sessions never fire', () => {
  const prev = new Map([['a', 'waiting']]);
  const next = new Map([['a', 'busy'], ['b', 'busy']]);
  assert.deepEqual(newlyWaiting(prev, next), []);
});

const { estimateCost, rateFor } = require('../lib/pricing');

test('rateFor matches by prefix with opus-tier fallback', () => {
  assert.equal(rateFor('claude-fable-5').input, 10);
  assert.equal(rateFor('claude-opus-5').input, 5);
  assert.equal(rateFor('claude-opus-4-8').input, 5);
  assert.equal(rateFor('claude-sonnet-5').output, 15);
  assert.equal(rateFor('claude-haiku-4-5-20251001').input, 1);
  assert.equal(rateFor('some-unknown-model').input, 5);
});

test('estimateCost applies cache read (0.1x) and write (1.25x) multipliers', () => {
  // 1M of each bucket on fable ($10 in / $50 out):
  // input 10 + output 50 + cacheRead 1 + cacheCreation 12.5 = 73.5
  const usd = estimateCost({
    'claude-fable-5': { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreation: 1e6 },
  });
  assert.ok(Math.abs(usd - 73.5) < 1e-9, String(usd));
});

test('estimateCost sums across models and handles empty', () => {
  assert.equal(estimateCost({}), 0);
  assert.equal(estimateCost(null), 0);
  const usd = estimateCost({
    'claude-haiku-4-5': { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 },
    'claude-sonnet-5': { input: 0, output: 1e6, cacheRead: 0, cacheCreation: 0 },
  });
  assert.ok(Math.abs(usd - 16) < 1e-9, String(usd)); // $1 + $15
});

const { matchesPrefix } = require('../lib/ignore');
const PREFIXES = ['/users/alex/local sites/buildertrend', '/users/alex/repos/buildertrend repos'];

test('matchesPrefix hides a prefix root and everything under it', () => {
  assert.equal(matchesPrefix('/Users/alex/Local Sites/buildertrend', PREFIXES), true);
  assert.equal(matchesPrefix('/Users/alex/Local Sites/buildertrend/app/public/wp-content/plugins/bt-blocks', PREFIXES), true);
  assert.equal(matchesPrefix('/Users/alex/repos/Buildertrend repos/bt-ai-tools', PREFIXES), true);
});

test('matchesPrefix does not match sibling paths or partial names', () => {
  assert.equal(matchesPrefix('/Users/alex/Projects/buildertrend-ideas', PREFIXES), false);
  assert.equal(matchesPrefix('/Users/alex/Local Sites/buildertrend-other', PREFIXES), false);
  assert.equal(matchesPrefix('/Users/alex/Local Sites/north-ave', PREFIXES), false);
});

// Windows-style paths must canonicalize to forward slashes and group correctly.
test('canonicalize normalizes Windows paths to forward slashes', () => {
  assert.equal(canonicalize('C:\\Users\\alex\\projects\\site\\'), 'C:/Users/alex/projects/site');
  assert.equal(canonicalize('C:/Users/alex/projects/site'), 'C:/Users/alex/projects/site');
});

test('worktreeRoot folds Windows worktree paths', () => {
  const r = worktreeRoot('C:\\Users\\alex\\site\\.claude\\worktrees\\brave-fox-1a2b3c');
  assert.equal(r.root, 'C:/Users/alex/site');
  assert.equal(r.worktree, 'brave-fox-1a2b3c');
});

test('encodeProjectDir handles drive letters', () => {
  assert.equal(encodeProjectDir('C:\\Users\\alex\\my site'), 'C--Users-alex-my-site');
});

test('matchesPrefix works across separator styles', () => {
  const prefixes = ['c:/users/alex/old sites'];
  assert.equal(matchesPrefix('C:\\Users\\alex\\Old Sites\\legacy', prefixes), true);
  assert.equal(matchesPrefix('C:\\Users\\alex\\other', prefixes), false);
});

// --- Daily usage bucketing (cost history) ---
const { scanLine, mergeDays, dailyCostSeries } = require('../lib/transcripts');

function assistantLine({ id, model, ts, input = 0, output = 0 }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, usage: { input_tokens: input, output_tokens: output } },
  });
}

function freshScan() {
  return { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null, lastModel: null };
}

// Local-time timestamps so the tests pass in any timezone.
const AUG10 = new Date(2026, 7, 10, 14, 30).toISOString();
const AUG11 = new Date(2026, 7, 11, 9, 0).toISOString();

test('scanLine buckets usage into local days per model', () => {
  const scan = freshScan();
  scanLine(assistantLine({ id: 'm1', model: 'claude-opus-5', ts: AUG10, input: 100, output: 10 }), scan);
  scanLine(assistantLine({ id: 'm2', model: 'claude-opus-5', ts: AUG11, input: 200, output: 20 }), scan);
  assert.equal(scan.days['2026-08-10']['claude-opus-5'].input, 100);
  assert.equal(scan.days['2026-08-11']['claude-opus-5'].output, 20);
  // totals still accumulate as before
  assert.equal(scan.usage['claude-opus-5'].input, 300);
});

test('scanLine day buckets dedupe by message id', () => {
  const scan = freshScan();
  const line = assistantLine({ id: 'm1', model: 'claude-opus-5', ts: AUG10, input: 100 });
  scanLine(line, scan);
  scanLine(line, scan);
  assert.equal(scan.days['2026-08-10']['claude-opus-5'].input, 100);
});

test('scanLine without timestamp still counts totals, skips day bucket', () => {
  const scan = freshScan();
  scanLine(JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 50 } } }), scan);
  assert.equal(scan.usage['claude-opus-5'].input, 50);
  assert.deepEqual(scan.days, {});
});

test('mergeDays merges nested day/model buckets', () => {
  const a = { '2026-08-10': { 'claude-opus-5': { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 } } };
  const b = {
    '2026-08-10': { 'claude-opus-5': { input: 50, output: 5, cacheRead: 0, cacheCreation: 0 } },
    '2026-08-11': { 'claude-sonnet-5': { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 } },
  };
  const m = mergeDays(mergeDays({}, a), b);
  assert.equal(m['2026-08-10']['claude-opus-5'].input, 150);
  assert.equal(m['2026-08-10']['claude-opus-5'].output, 5);
  assert.equal(m['2026-08-11']['claude-sonnet-5'].input, 10);
});

test('dailyCostSeries zero-fills and ends today', () => {
  const today = new Date(2026, 7, 11, 16, 0).getTime();
  const days = {
    '2026-08-10': { 'claude-opus-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } },
  };
  const series = dailyCostSeries([days], 3, today);
  assert.equal(series.length, 3);
  assert.equal(series[0].cost, 0); // Aug 9
  assert.equal(series[1].cost, 5); // Aug 10: 1M opus-5 input tokens at $5/MTok
  assert.equal(series[1].tokens, 1_000_000);
  assert.equal(series[2].t, new Date(2026, 7, 11).getTime()); // today, local midnight
  assert.equal(series[2].cost, 0);
});

// --- Week × hour heatmap ---
const { weekHourHeat } = require('../lib/history');

test('weekHourHeat counts prompts into [dayOfWeek][hour] cells', () => {
  // Sunday 2026-08-09 14:xx local, twice; Monday 2026-08-10 09:xx once.
  const ts = [
    new Date(2026, 7, 9, 14, 5).getTime(),
    new Date(2026, 7, 9, 14, 55).getTime(),
    new Date(2026, 7, 10, 9, 0).getTime(),
  ];
  const heat = weekHourHeat(ts);
  assert.equal(heat.length, 7);
  assert.equal(heat[0].length, 24);
  assert.equal(heat[0][14], 2); // Sunday 2pm
  assert.equal(heat[1][9], 1);  // Monday 9am
  assert.equal(heat[3][12], 0);
});

test('weekHourHeat handles empty input', () => {
  const heat = weekHourHeat([]);
  assert.equal(heat.length, 7);
  assert.equal(heat.flat().reduce((a, b) => a + b, 0), 0);
});

// --- Search query filters ---
const { parseSearchQuery } = require('../lib/search');

test('parseSearchQuery passes plain text through', () => {
  const p = parseSearchQuery('deploy hooks');
  assert.equal(p.text, 'deploy hooks');
  assert.equal(p.project, null);
  assert.equal(p.since, null);
});

test('parseSearchQuery extracts project: filter', () => {
  const p = parseSearchQuery('project:dashboard deploy');
  assert.equal(p.text, 'deploy');
  assert.equal(p.project, 'dashboard');
});

test('parseSearchQuery extracts since: with relative days', () => {
  const now = new Date(2026, 7, 15, 12, 0).getTime();
  const p = parseSearchQuery('since:7d deploy', now);
  assert.equal(p.text, 'deploy');
  assert.equal(p.since, now - 7 * 86400000);
});

test('parseSearchQuery extracts since: with a date', () => {
  const p = parseSearchQuery('since:2026-08-01 deploy');
  assert.equal(p.since, new Date(2026, 7, 1).getTime());
});

test('parseSearchQuery ignores malformed since: values', () => {
  const p = parseSearchQuery('since:soon deploy');
  assert.equal(p.since, null);
  assert.equal(p.text, 'deploy');
});

// --- Per-project notification mute ---
const { isProjectMuted } = require('../lib/notify');

test('isProjectMuted matches case-insensitively and tolerates separators', () => {
  const muted = ['/Users/alex/Projects/claude-dashboard'];
  assert.equal(isProjectMuted('/users/alex/projects/Claude-Dashboard', muted), true);
  assert.equal(isProjectMuted('/Users/alex/Projects/other', muted), false);
});

test('isProjectMuted handles empty or missing list', () => {
  assert.equal(isProjectMuted('/Users/alex/p', []), false);
  assert.equal(isProjectMuted('/Users/alex/p', undefined), false);
});

// --- Mission Control: subagent summary ---
const { subagentSummary } = require('../lib/transcripts');

test('subagentSummary carries count and tokens rounded to 0.1M', () => {
  const meta = {
    subagentCount: 3,
    subagentUsage: { 'claude-opus-5': { input: 1500000, output: 40000, cacheRead: 0, cacheCreation: 0 } },
  };
  assert.deepEqual(subagentSummary(meta), { count: 3, mtok: 1.5 });
});

test('subagentSummary is null without subagents', () => {
  assert.equal(subagentSummary({}), null);
  assert.equal(subagentSummary({ subagentCount: 0 }), null);
});

// --- Insights: response-time buckets ---
function userLine(ts, text) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } });
}

test('scanLine buckets the gap between assistant output and your next prompt', () => {
  const scan = freshScan();
  const t0 = new Date(2026, 7, 10, 14, 0, 0).getTime();
  scanLine(assistantLine({ id: 'm1', model: 'claude-opus-5', ts: new Date(t0).toISOString(), input: 10 }), scan);
  scanLine(userLine(new Date(t0 + 12000).toISOString(), 'next question'), scan);
  assert.deepEqual(scan.waits, [1, 0, 0, 0]); // 12s -> under 30s
  scanLine(assistantLine({ id: 'm2', model: 'claude-opus-5', ts: new Date(t0 + 60000).toISOString(), input: 10 }), scan);
  scanLine(userLine(new Date(t0 + 60000 + 5 * 60000).toISOString(), 'later'), scan);
  assert.deepEqual(scan.waits, [1, 0, 1, 0]); // 5m -> under 10m
});

test('scanLine wait tracking ignores tool results, long gaps, and double counts', () => {
  const scan = freshScan();
  const t0 = new Date(2026, 7, 10, 14, 0, 0).getTime();
  scanLine(assistantLine({ id: 'm1', model: 'claude-opus-5', ts: new Date(t0).toISOString(), input: 10 }), scan);
  // tool result (user-type record) must not count
  scanLine(JSON.stringify({ type: 'user', timestamp: new Date(t0 + 2000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }), scan);
  // away for 45 minutes: consumed but not counted
  scanLine(userLine(new Date(t0 + 45 * 60000).toISOString(), 'back now'), scan);
  // second prompt with no assistant in between: not counted
  scanLine(userLine(new Date(t0 + 46 * 60000).toISOString(), 'another'), scan);
  assert.deepEqual(scan.waits || [0, 0, 0, 0], [0, 0, 0, 0]);
});

// --- Budgets ---
const { budgetLevel } = require('../lib/pricing');

test('budgetLevel reports the highest threshold crossed', () => {
  assert.equal(budgetLevel(50, 100), 0);
  assert.equal(budgetLevel(75, 100), 75);
  assert.equal(budgetLevel(92, 100), 90);
  assert.equal(budgetLevel(140, 100), 100);
});

test('budgetLevel is 0 without a budget', () => {
  assert.equal(budgetLevel(50, 0), 0);
  assert.equal(budgetLevel(50, null), 0);
});

test('typicalWait names the median bucket', () => {
  const { typicalWait } = require('../lib/pricing');
  assert.equal(typicalWait([5, 1, 0, 0]), 'under 30s');
  assert.equal(typicalWait([1, 1, 4, 0]), 'under 10m');
  assert.equal(typicalWait([0, 0, 0, 0]), null);
});
