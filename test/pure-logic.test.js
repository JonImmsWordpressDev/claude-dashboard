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

const { estimateCost, rateFor, normalizeModel } = require('../lib/pricing');

test('rateFor matches by prefix, most specific first, with opus-tier fallback', () => {
  assert.equal(rateFor('claude-fable-5-1').input, 10);
  assert.equal(rateFor('claude-fable-5-1').cacheRead, 0.25); // not the usual 0.1x
  assert.equal(rateFor('claude-opus-5-5').input, 4);
  assert.equal(rateFor('claude-opus-5-5').cacheRead, 0.2);
  assert.equal(rateFor('claude-opus-5').input, 5);
  assert.equal(rateFor('claude-opus-4-8').input, 5);
  assert.equal(rateFor('claude-opus-4-1').input, 15);
  assert.equal(rateFor('claude-sonnet-5-5').output, 10);
  assert.equal(rateFor('claude-sonnet-4-6').output, 15);
  assert.equal(rateFor('claude-haiku-5-5').input, 0.1);
  assert.equal(rateFor('claude-haiku-4-5-20251001').input, 1);
  assert.equal(rateFor('claude-sonnet-5').cacheRead, 0.2); // default 0.1x input
  assert.equal(rateFor('claude-sonnet-5').cacheWrite, 2.5); // 1.25x input
  assert.equal(rateFor('claude-sonnet-5').assumed, false);
  assert.equal(rateFor('some-unknown-model').input, 5);
  assert.equal(rateFor('some-unknown-model').assumed, true);
  assert.equal(rateFor('us.anthropic.claude-sonnet-4-6-v1:0').input, 3);
  assert.equal(rateFor('us.anthropic.claude-sonnet-4-6-v1:0').assumed, false);
  assert.equal(rateFor('claude-opus-4-5@20251101').input, 5);
  assert.equal(rateFor('claude-opus-4-5@20251101').assumed, false);
  assert.equal(rateFor('claude-mythos-5-1').cacheRead, 0.25);
});

test('prototype-named model ids and override keys are treated as plain strings', () => {
  const { loadPricing: lp, costReport: cr } = require('../lib/pricing');
  for (const id of ['constructor', '__proto__']) {
    const r = rateFor(id);
    assert.equal(r.assumed, true);
    assert.equal(typeof r.input, 'number');
  }
  assert.equal(cr({ constructor: { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 } }).usd, 5);
  const t = lp(JSON.parse('{"overrides":{"__proto__":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1}}}'), null);
  assert.equal(overrideFor('input', t), null);
  assert.equal(rateFor('anything', t).assumed, true);
});

test('normalizeModel maps bare family aliases to the current generation', () => {
  assert.equal(normalizeModel('sonnet'), 'claude-sonnet-5-5');
  assert.equal(normalizeModel('opus'), 'claude-opus-5-5');
  assert.equal(normalizeModel('haiku'), 'claude-haiku-5-5');
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel(null), '');
  assert.equal(rateFor('sonnet').input, 2);
});

test('estimateCost uses the row cacheRead when set and 1.25x input for cache writes', () => {
  // 1M of each bucket on fable ($10 in / $50 out / $0.25 cache read):
  // input 10 + output 50 + cacheRead 0.25 + cacheCreation 12.5 = 72.75
  const usd = estimateCost({
    'claude-fable-5': { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreation: 1e6 },
  });
  assert.ok(Math.abs(usd - 72.75) < 1e-9, String(usd));
});

test('estimateCost sums across models and handles empty', () => {
  assert.equal(estimateCost({}), 0);
  assert.equal(estimateCost(null), 0);
  const usd = estimateCost({
    'claude-haiku-4-5': { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 },
    'claude-sonnet-5': { input: 0, output: 1e6, cacheRead: 0, cacheCreation: 0 },
  });
  assert.ok(Math.abs(usd - 11) < 1e-9, String(usd)); // $1 + $10
});

// --- modelPricing overrides (same shape as Claude Code's managed setting) ---
const { loadPricing, overrideFor, costReport } = require('../lib/pricing');

const SONNET_ROW = { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 };

test('loadPricing: managed wins whole over config; neither gives the empty table', () => {
  const managed = { multiplier: 0.85, overrides: { 'claude-sonnet-4-6': SONNET_ROW } };
  const config = { multiplier: 2, overrides: { 'claude-opus-5-5': SONNET_ROW } };
  const m = loadPricing(managed, config);
  assert.equal(m.source, 'managed');
  assert.equal(m.multiplier, 0.85);
  assert.deepEqual(Object.keys(m.overrides), ['claude-sonnet-4-6']);
  const c = loadPricing(null, config);
  assert.equal(c.source, 'config');
  assert.equal(c.multiplier, 2);
  const none = loadPricing(undefined, undefined);
  assert.deepEqual(none, { multiplier: 1, overrides: {}, source: null });
});

test('loadPricing: bad multiplier falls back to 1, bad rows drop one by one, never throws', () => {
  const raw = {
    multiplier: 'lots',
    overrides: {
      good: SONNET_ROW,
      negative: { ...SONNET_ROW, input: -1 },
      missing: { input: 1, output: 2, cacheRead: 0.1 },
      huge: { ...SONNET_ROW, output: 10001 },
      notObject: 'x',
    },
  };
  const p = loadPricing(raw, null);
  assert.equal(p.multiplier, 1);
  assert.deepEqual(Object.keys(p.overrides), ['good']);
  assert.deepEqual(loadPricing({ multiplier: 11 }, null).multiplier, 1);
  assert.deepEqual(loadPricing({ overrides: 'nope' }, null).overrides, {});
  assert.deepEqual(loadPricing('garbage', null).source, null);
});

test('overrideFor: exact key, then bare built-in id, then dated snapshot of a built-in id', () => {
  const pricing = loadPricing({ overrides: { 'claude-sonnet-4-6': SONNET_ROW, 'gw-alias': { ...SONNET_ROW, input: 9 } } }, null);
  assert.equal(overrideFor('claude-sonnet-4-6', pricing), pricing.overrides['claude-sonnet-4-6']);
  assert.equal(overrideFor('claude-sonnet-4-6-20260101', pricing), pricing.overrides['claude-sonnet-4-6']);
  assert.equal(overrideFor('us.anthropic.claude-sonnet-4-6-v1:0', pricing), pricing.overrides['claude-sonnet-4-6']);
  assert.equal(overrideFor('claude-sonnet-4-6@20260101', pricing), pricing.overrides['claude-sonnet-4-6']);
  assert.equal(overrideFor('gw-alias', pricing).input, 9);
  assert.equal(overrideFor('gw-alias-20260101', pricing), null); // non-built-in keys match exactly only
  assert.equal(overrideFor('claude-opus-5-5', pricing), null);
  assert.equal(overrideFor('claude-opus-5-5', null), null);
});

test('rateFor with pricing: override replaces the bundled row, cacheWrite is absolute, multiplier scales all', () => {
  const pricing = loadPricing({ multiplier: 0.5, overrides: { 'claude-sonnet-4-6': SONNET_ROW } }, null);
  const r = rateFor('claude-sonnet-4-6', pricing);
  assert.deepEqual(r, { input: 1.2, output: 6, cacheRead: 0.12, cacheWrite: 1.5, assumed: false });
  const bundled = rateFor('claude-opus-5-5', pricing); // no override: bundled x multiplier
  assert.equal(bundled.input, 2);
  assert.equal(bundled.cacheWrite, 2.5);
  const unknown = rateFor('mystery-model', pricing);
  assert.equal(unknown.assumed, true);
  const covered = rateFor('mystery-model', loadPricing({ overrides: { 'mystery-model': SONNET_ROW } }, null));
  assert.equal(covered.assumed, false); // an override clears the flag
});

test('costReport totals and lists the models that fell through to the default rate', () => {
  const usage = {
    'claude-opus-5-5': { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 },
    'mystery-b': { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 },
    'mystery-a': { input: 0, output: 1e6, cacheRead: 0, cacheCreation: 0 },
  };
  const r = costReport(usage);
  assert.ok(Math.abs(r.usd - (4 + 5 + 25)) < 1e-9, String(r.usd));
  assert.deepEqual(r.assumedModels, ['mystery-a', 'mystery-b']);
  assert.deepEqual(costReport({}), { usd: 0, assumedModels: [] });
  assert.deepEqual(costReport(null), { usd: 0, assumedModels: [] });
  assert.equal(estimateCost(usage), r.usd);
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
  return { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null, lastModel: null, changes: undefined };
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
  const doubled = dailyCostSeries([days], 3, today, require('../lib/pricing').loadPricing({ multiplier: 2 }, null));
  assert.equal(doubled[1].cost, 10);
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
const { subagentSummary, shouldReadMeta } = require('../lib/transcripts');

test('shouldReadMeta retries until a meta file has actually been parsed', () => {
  assert.equal(shouldReadMeta(undefined), true);
  assert.equal(shouldReadMeta({ agentFromMeta: false }), true);
  assert.equal(shouldReadMeta({ agentFromMeta: true }), false);
});

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

// --- Full-text transcript search ---
const { transcriptLineMatch } = require('../lib/search');

test('transcriptLineMatch finds text in user and assistant turns', () => {
  const u = JSON.stringify({ type: 'user', timestamp: '2026-08-10T14:00:00Z', message: { content: 'where is the Postgres config' } });
  const a = JSON.stringify({ type: 'assistant', timestamp: '2026-08-10T14:00:05Z', message: { content: [{ type: 'text', text: 'The postgres settings live in db.yml' }] } });
  const mu = transcriptLineMatch(u, 'postgres');
  assert.equal(mu.role, 'you');
  assert.ok(mu.text.includes('Postgres config'));
  const ma = transcriptLineMatch(a, 'postgres');
  assert.equal(ma.role, 'claude');
  assert.ok(ma.text.includes('db.yml'));
});

test('transcriptLineMatch skips tool results, harness noise, and non-matches', () => {
  const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'postgres blah' }] } });
  assert.equal(transcriptLineMatch(tool, 'postgres'), null);
  const noise = JSON.stringify({ type: 'user', message: { content: '<system-reminder>postgres</system-reminder>' } });
  assert.equal(transcriptLineMatch(noise, 'postgres'), null);
  const miss = JSON.stringify({ type: 'user', message: { content: 'nothing here' } });
  assert.equal(transcriptLineMatch(miss, 'postgres'), null);
});

// --- Linux terminal detection ---
const { findOnPath } = require('../lib/config');

test('findOnPath walks PATH dirs with the injected exists check', () => {
  const exists = (p) => p === '/usr/bin/kitty';
  assert.equal(findOnPath('kitty', '/usr/local/bin:/usr/bin', exists), '/usr/bin/kitty');
  assert.equal(findOnPath('missing', '/usr/local/bin:/usr/bin', exists), null);
  assert.equal(findOnPath('kitty', '', exists), null);
});

// --- What did Claude change: git log parsing + session linking ---
const { parseGitLog, linkCommitsToSessions } = require('../lib/gitlog');

test('parseGitLog splits records and attaches shortstat', () => {
  const raw = '\x1eaaa111\x1f1755200000\x1fFix the header\x1fJon Imms\x1fClaude Fable 5 <noreply@anthropic.com>\n' +
    ' 3 files changed, 40 insertions(+), 9 deletions(-)\n' +
    '\x1ebbb222\x1f1755100000\x1fManual tweak\x1fJon Imms\x1f\n';
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, 'aaa111');
  assert.equal(commits[0].ts, 1755200000000);
  assert.equal(commits[0].subject, 'Fix the header');
  assert.equal(commits[0].claude, true);
  assert.equal(commits[0].stat, '3 files changed, 40 insertions(+), 9 deletions(-)');
  assert.equal(commits[1].claude, false);
  assert.equal(commits[1].stat, null);
});

test('linkCommitsToSessions matches a commit inside a session activity window', () => {
  const commits = [{ sha: 'aaa111', ts: 1000000, claude: true }, { sha: 'bbb222', ts: 5000000, claude: true }];
  const sessions = [{ sessionId: 's1', title: 'Build the thing', startedAt: 900000, lastActivityAt: 1200000 }];
  const linked = linkCommitsToSessions(commits, sessions);
  assert.equal(linked[0].sessionId, 's1');
  assert.equal(linked[0].sessionTitle, 'Build the thing');
  assert.equal(linked[1].sessionId, undefined);
});

// --- Claude.ai chats import ---
const { normalizeChats, searchChats } = require('../lib/chats');

test('normalizeChats slims conversations and extracts text from content blocks', () => {
  const raw = [{
    uuid: 'c1', name: 'Trip planning', summary: '',
    created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-02T09:00:00Z',
    chat_messages: [
      { sender: 'human', text: 'Plan a trip to Lisbon', content: [], created_at: '2026-08-01T10:00:00Z' },
      { sender: 'assistant', text: '', content: [{ type: 'text', text: 'Three days is enough for...' }], created_at: '2026-08-01T10:00:30Z' },
    ],
  }, {
    uuid: 'c2', name: '', chat_messages: [],
    created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-01T10:00:00Z',
  }];
  const chats = normalizeChats(raw);
  assert.equal(chats.length, 1); // empty conversation dropped
  assert.equal(chats[0].id, 'c1');
  assert.equal(chats[0].name, 'Trip planning');
  assert.equal(chats[0].count, 2);
  assert.equal(chats[0].messages[0].who, 'you');
  assert.equal(chats[0].messages[1].who, 'claude');
  assert.equal(chats[0].messages[1].text, 'Three days is enough for...');
});

test('normalizeChats falls back to the first message for unnamed chats', () => {
  const raw = [{
    uuid: 'c3', name: '', created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-01T10:00:00Z',
    chat_messages: [{ sender: 'human', text: 'What is a CIDR block and why does it matter', content: [], created_at: '2026-08-01T10:00:00Z' }],
  }];
  assert.ok(normalizeChats(raw)[0].name.startsWith('What is a CIDR block'));
});

test('searchChats matches names and message text with snippets', () => {
  const chats = [{
    id: 'c1', name: 'Trip planning', updatedAt: 100,
    messages: [{ who: 'claude', text: 'Book the Alfama walking tour early', ts: 90 }],
  }];
  const byName = searchChats('trip', chats);
  assert.equal(byName[0].chatId, 'c1');
  const byText = searchChats('alfama', chats);
  assert.ok(byText[0].snippet.toLowerCase().includes('alfama'));
  assert.equal(searchChats('nothing-here', chats).length, 0);
});

// --- Install-kind detection (self-update) ---
const { detectInstallKind, updatePlan, npmCliCandidates } = require('../lib/update');

test('detectInstallKind: git checkout wins when a .git dir is present', () => {
  assert.equal(detectInstallKind('/Users/alex/AI Projects/claude-dashboard', true), 'git');
});

test('detectInstallKind: global npm install', () => {
  assert.equal(
    detectInstallKind('/usr/local/lib/node_modules/claude-mission-control', false),
    'npm'
  );
});

test('detectInstallKind: npx cache is npx even though it sits in node_modules', () => {
  assert.equal(
    detectInstallKind('/Users/alex/.npm/_npx/abc123/node_modules/claude-mission-control', false),
    'npx'
  );
});

test('detectInstallKind: brew Cellar is brew even with node_modules and .git absent checks', () => {
  assert.equal(
    detectInstallKind('/opt/homebrew/Cellar/claude-mission-control/1.7.0/libexec/lib/node_modules/claude-mission-control', false),
    'brew'
  );
});

test('detectInstallKind: brew/npx path signals beat a stray .git dir', () => {
  assert.equal(
    detectInstallKind('/Users/alex/.npm/_npx/abc123/node_modules/claude-mission-control', true),
    'npx'
  );
});

test('detectInstallKind: Windows npx cache path', () => {
  assert.equal(
    detectInstallKind('C:\\Users\\alex\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\claude-mission-control', false),
    'npx'
  );
});

test('detectInstallKind: pnpm/yarn/volta/bun globals are not npm (manual instead)', () => {
  assert.equal(detectInstallKind('/Users/alex/Library/pnpm/global/5/node_modules/claude-mission-control', false), 'unknown');
  assert.equal(detectInstallKind('/Users/alex/.config/yarn/global/node_modules/claude-mission-control', false), 'unknown');
  assert.equal(detectInstallKind('/Users/alex/.volta/tools/image/packages/claude-mission-control/lib/node_modules/claude-mission-control', false), 'unknown');
  assert.equal(detectInstallKind('/Users/alex/.bun/install/global/node_modules/claude-mission-control', false), 'unknown');
});

test('detectInstallKind: plain directory with no signals is unknown', () => {
  assert.equal(detectInstallKind('/Users/alex/Downloads/claude-dashboard', false), 'unknown');
});


test('updatePlan: git installs run git pull --ff-only in the app dir', () => {
  const plan = updatePlan('git');
  assert.equal(plan.type, 'run');
  assert.equal(plan.cmd, 'git');
  assert.deepEqual(plan.args, ['pull', '--ff-only']);
});

test('updatePlan: npm installs reinstall the published package by name', () => {
  const plan = updatePlan('npm', 'claude-mission-control');
  assert.equal(plan.type, 'run');
  assert.equal(plan.cmd, 'npm');
  assert.deepEqual(plan.args, ['install', '-g', 'claude-mission-control@latest']);
});

test('updatePlan: brew and npx are manual with a command to show', () => {
  const brew = updatePlan('brew', 'claude-mission-control');
  assert.equal(brew.type, 'manual');
  assert.ok(brew.message.includes('brew upgrade claude-mission-control'));
  const npx = updatePlan('npx', 'claude-mission-control');
  assert.equal(npx.type, 'manual');
  assert.ok(npx.message.toLowerCase().includes('npx'));
});

test('updatePlan: unknown installs get manual instructions, never a command', () => {
  const plan = updatePlan('unknown');
  assert.equal(plan.type, 'manual');
});

test('npmCliCandidates covers the unix prefix and Windows layouts', () => {
  const unix = npmCliCandidates('/opt/homebrew/bin');
  assert.ok(unix.some((p) => p.replace(/\\/g, '/').endsWith('/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js')));
  const win = npmCliCandidates('C:/Program Files/nodejs');
  assert.ok(win.some((p) => p.replace(/\\/g, '/').endsWith('C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js')));
});

// --- custom session names ---
const { applySessionName } = require('../lib/config');

test('sessionTitle prefers a custom name over the transcript-derived title', () => {
  const { sessionTitle } = require('../lib/transcripts');
  const meta = { sessionId: 'abc12345-x', aiTitle: 'Fix the login bug', firstUserPrompt: 'help me' };
  assert.deepEqual(sessionTitle(meta, { 'abc12345-x': 'Login work' }), { title: 'Login work', source: 'custom' });
  assert.deepEqual(sessionTitle(meta, { 'other': 'nope' }), { title: 'Fix the login bug', source: 'ai-title' });
  assert.deepEqual(sessionTitle(meta), { title: 'Fix the login bug', source: 'ai-title' });
});

test('applySessionName trims, caps at 80 chars, and deletes on empty', () => {
  const a = applySessionName({}, 's1', '  My session  ');
  assert.deepEqual(a, { s1: 'My session' });
  const b = applySessionName(a, 's2', 'x'.repeat(100));
  assert.equal(b.s2.length, 80);
  assert.equal(b.s1, 'My session');
  const c = applySessionName(b, 's1', '   ');
  assert.deepEqual(Object.keys(c), ['s2']);
  assert.deepEqual(Object.keys(applySessionName({ s1: 'a' }, 's1', '')), []);
});

test('applySessionName does not mutate its input', () => {
  const orig = { s1: 'a' };
  applySessionName(orig, 's1', 'b');
  assert.deepEqual(orig, { s1: 'a' });
});

// --- self-update outcome ---
const { updateOutcome } = require('../lib/update');

test('updateOutcome restarts when the on-disk version differs from the running one', () => {
  // Tree already pulled by hand (or a previous click): running 1.8.0, disk 1.9.0.
  assert.deepEqual(updateOutcome('1.8.0', '1.9.0', true), { unchanged: false, willRestart: true });
  assert.deepEqual(updateOutcome('1.8.0', '1.9.0', false), { unchanged: false, willRestart: false });
});

test('updateOutcome reports unchanged when disk still matches the running version', () => {
  assert.deepEqual(updateOutcome('1.8.0', '1.8.0', true), { unchanged: true, willRestart: false });
  assert.deepEqual(updateOutcome('1.8.0', null, true), { unchanged: true, willRestart: false });
});

// --- waitingReason and reasonText ---
const { waitingReason, reasonText } = require('../lib/transcripts');

// Transcript record builders. Shapes mirror real ~/.claude transcripts.
function userPrompt(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function toolResult(id) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } };
}
function assistantText(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}
function assistantTool(id, name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function askQuestion(id, question, labels) {
  return assistantTool(id, 'AskUserQuestion', {
    questions: [{ question, header: 'Pick', multiSelect: false, options: labels.map((label) => ({ label, description: '' })) }],
  });
}

test('waitingReason: pending AskUserQuestion yields a question with option labels', () => {
  const r = waitingReason([
    userPrompt('build it'),
    assistantText('Some thinking first.'),
    askQuestion('t1', 'Which payment provider?', ['Stripe', 'Adyen', 'Braintree']),
  ]);
  assert.deepEqual(r, { kind: 'question', text: 'Which payment provider?', options: ['Stripe', 'Adyen', 'Braintree'] });
});

test('waitingReason: an answered question falls through to the later text', () => {
  const r = waitingReason([
    userPrompt('build it'),
    askQuestion('t1', 'Which payment provider?', ['Stripe', 'Adyen']),
    toolResult('t1'),
    assistantText('Going with Stripe. Shall I also wire the webhook?'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Going with Stripe. Shall I also wire the webhook?' });
});

test('waitingReason: pending Bash call is a permission with the command', () => {
  const r = waitingReason([
    userPrompt('run the tests'),
    assistantTool('t2', 'Bash', { command: 'npm test -- checkout', description: 'Run checkout tests' }),
  ]);
  assert.deepEqual(r, { kind: 'permission', text: 'Bash npm test -- checkout' });
});

test('waitingReason: pending Edit call is a permission with the file path', () => {
  const r = waitingReason([
    userPrompt('fix it'),
    assistantTool('t3', 'Edit', { file_path: '/repo/src/cart.ts', old_string: 'a', new_string: 'b' }),
  ]);
  assert.deepEqual(r, { kind: 'permission', text: 'Edit /repo/src/cart.ts' });
});

test('waitingReason: permission text is capped at 120 characters', () => {
  const r = waitingReason([userPrompt('go'), assistantTool('t4', 'Bash', { command: 'x'.repeat(500) })]);
  assert.equal(r.kind, 'permission');
  assert.equal(r.text.length, 120);
});

test('waitingReason: reply uses the last line ending in a question mark', () => {
  const r = waitingReason([
    userPrompt('go'),
    assistantText('Done with the endpoint.\n\nTwo options remain.\n\nWhich one do you want?\n\nI can start either now.'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Which one do you want?' });
});

test('waitingReason: reply without a question mark uses the first line of the final paragraph', () => {
  const r = waitingReason([
    userPrompt('go'),
    assistantText('## Summary\n\nAll 14 tests pass.\n\n- **Next:** deploy when ready.\n- second bullet'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Next: deploy when ready.' });
});

test('waitingReason: only the last turn counts — an old question is not resurfaced', () => {
  const r = waitingReason([
    userPrompt('first'),
    askQuestion('t1', 'Old question?', ['a', 'b']),
    userPrompt('second prompt, answered by typing'),
    assistantText('Okay, doing that now.'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Okay, doing that now.' });
});

test('waitingReason: harness noise user records do not start a new turn', () => {
  const r = waitingReason([
    userPrompt('go'),
    askQuestion('t1', 'Which one?', ['a', 'b']),
    userPrompt('<local-command-caveat>Caveat: the messages below…</local-command-caveat>'),
  ]);
  assert.equal(r.kind, 'question');
});

test('waitingReason: sidechain records are ignored', () => {
  const r = waitingReason([
    userPrompt('go'),
    { ...assistantTool('s1', 'Bash', { command: 'ls' }), isSidechain: true },
    assistantText('Finished.'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Finished.' });
});

test('waitingReason: question text and options are capped', () => {
  const r = waitingReason([userPrompt('go'), askQuestion('t1', 'q'.repeat(400), ['a'.repeat(80), 'b', 'c', 'd', 'e', 'f', 'g'])]);
  assert.equal(r.text.length, 200);
  assert.equal(r.options.length, 6);
  assert.equal(r.options[0].length, 40);
});

test('waitingReason: no assistant turn returns null', () => {
  assert.equal(waitingReason([userPrompt('hello')]), null);
  assert.equal(waitingReason([]), null);
});

test('waitingReason: a plain-string last prompt still starts a new turn', () => {
  const r = waitingReason([
    userPrompt('first'),
    askQuestion('t1', 'Old question?', ['a', 'b']),
    { type: 'user', message: { role: 'user', content: 'second prompt' } },
    assistantText('Okay, doing that now.'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Okay, doing that now.' });
});

test('waitingReason: backticked identifiers keep their underscores, lose the backticks', () => {
  const r = waitingReason([
    userPrompt('go'),
    assistantText('Rename `file_path` to `path`?'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'Rename file_path to path?' });
});

test('waitingReason: a doubled list marker is fully stripped', () => {
  const r = waitingReason([
    userPrompt('go'),
    assistantText('Some notes.\n\n- 1. first item\n- second item'),
  ]);
  assert.deepEqual(r, { kind: 'reply', text: 'first item' });
});

test('waitingReason: a pending ExitPlanMode reads as a plain approval prompt', () => {
  const r = waitingReason([
    userPrompt('plan it'),
    assistantTool('t5', 'ExitPlanMode', { plan: '## Plan\n\n1. Do the thing\n2. Do the other thing' }),
  ]);
  assert.deepEqual(r, { kind: 'permission', text: 'ExitPlanMode approve the plan' });
});

test('Collector.reasonFor: waitingFor wins over the stored transcript reason', () => {
  const { Collector } = require('../lib/collector');
  const c = new Collector();
  c.raw.metaBySession.set('s1', { waitingReason: { kind: 'question', text: 'Which?', options: ['a'] } });
  assert.deepEqual(
    c.reasonFor({ sessionId: 's1', waitingFor: 'typed answer' }),
    { kind: 'reply', text: 'typed answer' }
  );
  assert.deepEqual(
    c.reasonFor({ sessionId: 's1', waitingFor: null }),
    { kind: 'question', text: 'Which?', options: ['a'] }
  );
  assert.equal(c.reasonFor({ sessionId: 'nope' }), null);
});

test('reasonText formats each kind for a notification body', () => {
  assert.equal(reasonText({ kind: 'question', text: 'Which one?', options: ['a', 'b'] }), 'Which one? (a / b)');
  assert.equal(reasonText({ kind: 'question', text: 'Which one?', options: [] }), 'Which one?');
  assert.equal(reasonText({ kind: 'permission', text: 'Bash npm test' }), 'permission: Bash npm test');
  assert.equal(reasonText({ kind: 'reply', text: 'Shall I continue?' }), 'Shall I continue?');
  assert.equal(reasonText(null), 'Claude is waiting for your input');
});

const { diffLines } = require('../lib/diff');

test('diffLines: identical inputs produce no hunks', () => {
  const r = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepEqual(r, { hunks: [], added: 0, removed: 0, truncated: false, tooLarge: false });
});

test('diffLines: pure insert', () => {
  const r = diffLines('a\nb\n', 'a\nx\nb\n');
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
  assert.equal(r.hunks.length, 1);
  assert.deepEqual(r.hunks[0].lines, [[' ', 'a'], ['+', 'x'], [' ', 'b']]);
  assert.deepEqual([r.hunks[0].aStart, r.hunks[0].aLines, r.hunks[0].bStart, r.hunks[0].bLines], [1, 2, 1, 3]);
});

test('diffLines: pure delete', () => {
  const r = diffLines('a\nx\nb\n', 'a\nb\n');
  assert.equal(r.added, 0);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.hunks[0].lines, [[' ', 'a'], ['-', 'x'], [' ', 'b']]);
});

test('diffLines: replacement in the middle', () => {
  const r = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(r.hunks[0].lines, [[' ', 'a'], ['-', 'b'], ['+', 'B'], [' ', 'c']]);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
});

test('diffLines: distant edits become two hunks with 3 lines of context', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l2', 'L2').replace('l17', 'L17');
  const r = diffLines(a, b);
  assert.equal(r.hunks.length, 2);
  assert.equal(r.hunks[0].aStart, 1);           // context can't go above line 1
  assert.deepEqual(r.hunks[0].lines.map((l) => l[0]), [' ', ' ', '-', '+', ' ', ' ', ' ']);
  assert.equal(r.hunks[1].aStart, 15);          // l14 is index 14 → line 15
  assert.equal(r.hunks[1].bStart, 15);
});

test('diffLines: nearby edits merge into one hunk', () => {
  const a = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l3', 'L3').replace('l7', 'L7'); // 3 unchanged lines between → merged
  const r = diffLines(a, b);
  assert.equal(r.hunks.length, 1);
});

test('diffLines: trailing newline difference alone is not a change', () => {
  assert.equal(diffLines('a\nb', 'a\nb\n').hunks.length, 0);
});

test('diffLines: empty original is a pure insert; empty result is a pure delete', () => {
  assert.equal(diffLines('', 'a\nb\n').added, 2);
  assert.equal(diffLines('a\nb\n', '').removed, 2);
  assert.deepEqual(diffLines('', '').hunks, []);
});

test('diffLines: maxChanges caps the output and sets truncated', () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
  const r = diffLines(a, b, { maxChanges: 10 });
  assert.equal(r.truncated, true);
  const changed = r.hunks.flatMap((h) => h.lines).filter((l) => l[0] !== ' ').length;
  assert.ok(changed <= 10, `expected ≤10 changed lines, got ${changed}`);
});

test('diffLines: oversized input is refused with tooLarge', () => {
  const big = 'x'.repeat(500 * 1024);
  const r = diffLines(big, 'y');
  assert.equal(r.tooLarge, true);
  assert.deepEqual(r.hunks, []);
});
const { recordChange, mergeChanges } = require('../lib/changes');

test('recordChange adds versions in order and dedupes by version', () => {
  const c = {};
  recordChange(c, '/p/a.js', { backupFileName: 'h@v2', version: 2, backupTime: '2026-09-12T10:00:02.000Z' });
  recordChange(c, '/p/a.js', { backupFileName: 'h@v1', version: 1, backupTime: '2026-09-12T10:00:01.000Z' });
  recordChange(c, '/p/a.js', { backupFileName: 'h@v2', version: 2, backupTime: '2026-09-12T10:00:02.000Z' });
  assert.deepEqual(c['/p/a.js'].versions.map((v) => v.v), [1, 2]);
  assert.equal(c['/p/a.js'].versions[0].backup, 'h@v1');
  assert.equal(c['/p/a.js'].first, Date.parse('2026-09-12T10:00:01.000Z'));
  assert.equal(c['/p/a.js'].last, Date.parse('2026-09-12T10:00:02.000Z'));
});

test('mergeChanges unions paths and versions', () => {
  const a = {};
  recordChange(a, '/p/a.js', { backupFileName: 'h@v1', version: 1, backupTime: '2026-09-12T10:00:01.000Z' });
  const b = {};
  recordChange(b, '/p/a.js', { backupFileName: 'h@v2', version: 2, backupTime: '2026-09-12T10:00:02.000Z' });
  recordChange(b, '/p/b.js', { backupFileName: 'g@v1', version: 1, backupTime: '2026-09-12T10:00:03.000Z' });
  mergeChanges(a, b);
  assert.deepEqual(Object.keys(a).sort(), ['/p/a.js', '/p/b.js']);
  assert.deepEqual(a['/p/a.js'].versions.map((v) => v.v), [1, 2]);
});

test('scanLine: a file-history-delta records the real path and version', () => {
  const scan = freshScan();
  scanLine(JSON.stringify({
    type: 'file-history-delta', messageId: 'm', snapshotMessageId: 's',
    trackingPath: '/enc/odd/path/lib/config.js',
    backup: { backupFileName: '8c806e5de25a5806@v1', version: 1, backupTime: '2026-08-26T12:20:00.000Z', realParentDir: '/Users/x/repo/lib' },
  }), scan);
  assert.deepEqual(Object.keys(scan.changes), ['/Users/x/repo/lib/config.js']);
  assert.equal(scan.changes['/Users/x/repo/lib/config.js'].versions[0].backup, '8c806e5de25a5806@v1');
});

test('scanLine: a file-history-snapshot merges every tracked backup', () => {
  const scan = freshScan();
  scanLine(JSON.stringify({
    type: 'file-history-snapshot', messageId: 'm',
    snapshot: { messageId: 'm', timestamp: 't', trackedFileBackups: {
      'README.md': { backupFileName: '2e90@v2', version: 2, backupTime: '2026-08-26T12:21:56.192Z', realParentDir: '/Users/x/repo' },
      'lib/update.js': { backupFileName: 'f8b7@v2', version: 2, backupTime: '2026-08-26T12:21:56.192Z', realParentDir: '/Users/x/repo/lib' },
    } },
  }), scan);
  assert.deepEqual(Object.keys(scan.changes).sort(), ['/Users/x/repo/README.md', '/Users/x/repo/lib/update.js']);
});

test('scanLine: a snapshot repeating a delta version is a no-op; count is distinct paths', () => {
  const scan = freshScan();
  const bk = { backupFileName: '2e90@v1', version: 1, backupTime: '2026-08-26T12:21:56.192Z', realParentDir: '/Users/x/repo' };
  scanLine(JSON.stringify({ type: 'file-history-delta', trackingPath: 'README.md', backup: bk }), scan);
  scanLine(JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'README.md': bk } } }), scan);
  assert.equal(scan.changes['/Users/x/repo/README.md'].versions.length, 1);
  assert.equal(Object.keys(scan.changes).length, 1);
});

test('scanLine: an empty snapshot creates no changes map', () => {
  const scan = freshScan();
  scanLine(JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } }), scan);
  assert.equal(scan.changes, undefined);
});

test('mergeChanges into a fresh map leaves the source entries untouched', () => {
  const cached = {};
  recordChange(cached, '/p/a.js', { backupFileName: 'h@v1', version: 1, backupTime: '2026-09-12T10:00:01.000Z' });
  const sub = {};
  recordChange(sub, '/p/a.js', { backupFileName: 'h@v2', version: 2, backupTime: '2026-09-12T10:00:02.000Z' });
  const merged = mergeChanges(mergeChanges({}, cached), sub);
  assert.deepEqual(merged['/p/a.js'].versions.map(v => v.v), [1, 2]);
  assert.deepEqual(cached['/p/a.js'].versions.map(v => v.v), [1]);
  assert.notEqual(merged['/p/a.js'], cached['/p/a.js']);
});

const { changeFiles, relPath, backupPath, diffTarget, realPathOf, sessionChangeList, sessionFileDiff } = require('../lib/changes');

test('changeFiles orders by last edit desc and numbers stably', () => {
  const c = {
    '/r/b.js': { versions: [{ v: 1, backup: 'b@v1', at: 10 }], first: 10, last: 10 },
    '/r/a.js': { versions: [{ v: 1, backup: 'a@v1', at: 5 }, { v: 2, backup: 'a@v2', at: 30 }], first: 5, last: 30 },
  };
  const files = changeFiles(c);
  assert.deepEqual(files.map((f) => [f.n, f.path]), [[0, '/r/a.js'], [1, '/r/b.js']]);
});

test('relPath strips the project root, leaves outside paths absolute', () => {
  assert.equal(relPath('/r/lib/x.js', '/r'), 'lib/x.js');
  assert.equal(relPath('/r/lib/x.js', '/r/'), 'lib/x.js');
  assert.equal(relPath('/Users/me/.claude/projects/p/memory/m.md', '/r'), '/Users/me/.claude/projects/p/memory/m.md');
  assert.equal(relPath('/rest/x.js', '/r'), '/rest/x.js'); // prefix but not a directory boundary
});

test('backupPath confines reads to the session directory', () => {
  const p = backupPath('e84aac52-9396-4e16-9b0f-22e515c501e0', '6a2e7148c75ec392@v1');
  assert.ok(p.endsWith('/file-history/e84aac52-9396-4e16-9b0f-22e515c501e0/6a2e7148c75ec392@v1'));
  assert.equal(backupPath('../sessions', '6a2e7148c75ec392@v1'), null);
  assert.equal(backupPath('e84aac52-9396-4e16-9b0f-22e515c501e0', '../../settings.json'), null);
  assert.equal(backupPath('e84aac52-9396-4e16-9b0f-22e515c501e0', 'zz@v1'), null);
});

test('diffTarget: anything but a positive integer means the file on disk', () => {
  assert.equal(diffTarget(undefined), 'disk');
  assert.equal(diffTarget(null), 'disk');
  assert.equal(diffTarget('disk'), 'disk');
  assert.equal(diffTarget(NaN), 'disk');
  assert.equal(diffTarget(0), 'disk');
  assert.equal(diffTarget('2'), 2);
  assert.equal(diffTarget(3), 3);
});

test('recordChange keeps a null backup at v1 (file created), ignores one at v>1', () => {
  const c = {};
  recordChange(c, '/p/new.js', { backupFileName: null, version: 1, backupTime: '2026-09-12T10:00:00.000Z' });
  assert.deepEqual(c['/p/new.js'].versions, [{ v: 1, backup: null, at: Date.parse('2026-09-12T10:00:00.000Z') }]);
  recordChange(c, '/p/new.js', { backupFileName: 'h@v2', version: 2, backupTime: '2026-09-12T10:00:02.000Z' });
  recordChange(c, '/p/new.js', { backupFileName: null, version: 3, backupTime: '2026-09-12T10:00:03.000Z' });
  assert.deepEqual(c['/p/new.js'].versions.map((v) => v.v), [1, 2]);
});

test('sessionChangeList: a created file (v1 null backup) diffs against empty original', async () => {
  const changes = { '/p/new.js': { versions: [{ v: 1, backup: null, at: 10 }], first: 10, last: 10 } };
  const reader = async (p) => (p === '/p/new.js' ? 'a\nb\n' : null);
  const { files } = await sessionChangeList({ sessionId: 's', changes, root: '/p', readFile: reader });
  assert.deepEqual(files[0], {
    n: 0, path: '/p/new.js', rel: 'new.js', versions: [1], first: 10, last: 10,
    exists: true, missingBackup: false, added: 2, removed: 0, tooLarge: false, truncated: false,
  });
});

test('sessionFileDiff: v1 null backup with no `to` is a pure insert against disk', async () => {
  const changes = { '/p/new.js': { versions: [{ v: 1, backup: null, at: 10 }], first: 10, last: 10 } };
  const reader = async (p) => (p === '/p/new.js' ? 'a\nb\n' : null);
  const d = await sessionFileDiff({ sessionId: 's', changes, n: 0, from: undefined, to: undefined, root: '/p', readFile: reader });
  assert.equal(d.from, 1);
  assert.equal(d.to, 'disk');
  assert.equal(d.hunks.length, 1);
  assert.deepEqual(d.hunks[0].lines, [['+', 'a'], ['+', 'b']]);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

test('realPathOf: joins realParentDir with the key basename', () => {
  assert.equal(realPathOf('/private/tmp/x/y.md', { realParentDir: '/real/dir' }), '/real/dir/y.md');
  assert.equal(realPathOf('/private/tmp/x/y.md', { realParentDir: '/real/dir/' }), '/real/dir/y.md');
  assert.equal(realPathOf(null, { realParentDir: '/real/dir' }), null);
  assert.equal(realPathOf('/private/tmp/x/y.md', { realParentDir: undefined }), null);
  assert.equal(realPathOf('/private/tmp/x/y.md', null), null);
});

const { applySessionNote } = require('../lib/config');

test('applySessionNote trims, caps at 2000 chars, and deletes on empty', () => {
  const a = applySessionNote({}, 's1', '  remember the webhook  ');
  assert.deepEqual(a, { s1: 'remember the webhook' });
  const b = applySessionNote(a, 's1', 'x'.repeat(2500));
  assert.equal(b.s1.length, 2000);
  const c = applySessionNote(b, 's1', '   ');
  assert.deepEqual(c, {});
  assert.deepEqual(applySessionNote(undefined, 's2', 'n'), { s2: 'n' });
});

test('applySessionNote does not mutate its input', () => {
  const orig = { s1: 'keep' };
  const next = applySessionNote(orig, 's2', 'new');
  assert.deepEqual(orig, { s1: 'keep' });
  assert.deepEqual(next, { s1: 'keep', s2: 'new' });
});

const { searchNotes } = require('../lib/search');

test('searchNotes matches note text with project and since filters', () => {
  const groups = new Map([
    ['/r/alpha', { path: '/r/alpha', sessions: [{ sessionId: 'a1', lastActivityAt: 1000 }, { sessionId: 'a2', lastActivityAt: 5000 }] }],
    ['/r/beta', { path: '/r/beta', sessions: [{ sessionId: 'b1', lastActivityAt: 9000 }] }],
  ]);
  const notes = { a1: 'Remember the Stripe webhook', a2: 'unrelated', b1: 'stripe keys rotated' };
  const all = searchNotes('stripe', groups, notes);
  assert.deepEqual(all.map((r) => r.sessionId), ['b1', 'a1']); // newest first
  assert.equal(all[1].project, '/r/alpha');
  assert.deepEqual(searchNotes('stripe project:beta', groups, notes).map((r) => r.sessionId), ['b1']);
  assert.deepEqual(searchNotes('stripe since:2026-01-01', groups, notes, Date.parse('2026-06-01')).map((r) => r.sessionId), []);
});

test('searchNotes since: filter keeps only sessions active on or after the cutoff', () => {
  const groups = new Map([
    ['/r/alpha', {
      path: '/r/alpha',
      sessions: [
        { sessionId: 'new1', lastActivityAt: Date.parse('2026-09-10') },
        { sessionId: 'old1', lastActivityAt: Date.parse('2026-08-01') },
      ],
    }],
  ]);
  const notes = { new1: 'stripe webhook fixed', old1: 'stripe keys rotated' };
  const now = Date.parse('2026-09-15');
  assert.deepEqual(
    searchNotes('stripe since:2026-09-01', groups, notes, now).map((r) => r.sessionId),
    ['new1']
  );
});

test('searchNotes snippet is ellipsis-prefixed for a late match and tolerates non-string note values', () => {
  const groups = new Map([
    ['/r/alpha', {
      path: '/r/alpha',
      sessions: [
        { sessionId: 'late', lastActivityAt: 1000 },
        { sessionId: 'weird', lastActivityAt: 2000 },
      ],
    }],
  ]);
  const notes = {
    late: 'x'.repeat(80) + ' stripe webhook secret rotated',
    weird: { a1: 42 },
  };
  const results = searchNotes('stripe', groups, notes);
  assert.deepEqual(results.map((r) => r.sessionId), ['late']);
  assert.equal(results[0].snippet.startsWith('…'), true);
});

const { mergePlugins, mergeMcp, publicServer, redactUrl } = require('../lib/inventory');

const DAY = 86400000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

test('mergePlugins joins installs with enabled state and marketplace freshness', () => {
  const installed = {
    'superpowers@official': [{ scope: 'user', installPath: '/plugins/cache/x/a/1.0.0', version: 'abc123', installedAt: '2026-08-01T00:00:00Z', lastUpdated: '2026-08-20T00:00:00Z' }],
    'figma@official': [{ scope: 'user', version: '2.2.111', installedAt: '2026-08-01T00:00:00Z', lastUpdated: '2026-09-01T00:00:00Z' }],
  };
  const enabled = { 'superpowers@official': true, 'figma@official': false, 'ghost@official': true };
  const markets = { official: { lastUpdated: '2026-09-01T00:00:00Z' } };
  const rows = mergePlugins(installed, enabled, markets, T0);
  assert.deepEqual(rows.map((r) => [r.id, r.enabled, r.installed, r.stale]), [
    ['ghost@official', true, false, false],
    ['superpowers@official', true, true, true],   // marketplace refreshed 12 days after the plugin
    ['figma@official', false, true, false],
  ]);
  assert.equal(rows[1].name, 'superpowers');
  assert.equal(rows[1].marketplace, 'official');
  assert.equal(rows[1].version, 'abc123');
  assert.equal(rows.find((r) => r.installed).installPath, '/plugins/cache/x/a/1.0.0');
  assert.equal(rows.find((r) => !r.installed).installPath, null);
});

test('mergePlugins: within a day of the marketplace refresh is not stale', () => {
  const rows = mergePlugins(
    { 'a@m': [{ version: '1', lastUpdated: '2026-09-01T00:00:00Z' }] },
    {},
    { m: { lastUpdated: '2026-09-01T12:00:00Z' } },
    T0
  );
  assert.equal(rows[0].stale, false);
  assert.equal(rows[0].enabled, false); // absent from enabledPlugins = off
});

test('publicServer strips env and headers and counts args', () => {
  const out = publicServer({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { TOKEN: 'secret' }, headers: { Authorization: 'Bearer s' } });
  assert.deepEqual(out, { type: 'stdio', command: 'npx', args: 2, url: null });
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.deepEqual(publicServer({ url: 'https://mcp.example/sse' }), { type: 'http', command: null, args: 0, url: 'https://mcp.example/sse' });
});

test('publicServer coerces a non-string type to http/stdio based on url', () => {
  assert.equal(publicServer({ type: 42, url: 'https://mcp.example/sse' }).type, 'http');
  assert.equal(publicServer({ type: 42 }).type, 'stdio');
  assert.equal(publicServer({ type: 'sse' }).type, 'sse');
});

test('redactUrl keeps origin and first path segment only, dropping userinfo/query/rest of path', () => {
  assert.equal(
    redactUrl('https://user:sekret@mcp.zapier.com/api/mcp/s/SECRET-TOKEN/mcp?api_key=Q'),
    'https://mcp.zapier.com/api/…'
  );
  assert.equal(redactUrl('https://mcp.sentry.dev/mcp'), 'https://mcp.sentry.dev/mcp');
  assert.equal(redactUrl('not a url'), null);
});

test('publicServer never leaks a secret embedded in the url', () => {
  const out = publicServer({ url: 'https://user:sekret@mcp.zapier.com/api/mcp/s/SECRET-TOKEN/mcp?api_key=Q', env: { T: 's' }, headers: { Authorization: 'x' } });
  const json = JSON.stringify(out);
  assert.equal(json.includes('sekret'), false);
  assert.equal(json.includes('SECRET-TOKEN'), false);
  assert.equal(json.includes('api_key'), false);
});

test('mergeMcp unions global, per-project, and .mcp.json servers with projects and auth flags', () => {
  const rows = mergeMcp({
    global: { sentry: { url: 'https://s/mcp' } },
    byProject: { '/r/a': { ruflo: { command: 'ruflo' } }, '/r/b': { ruflo: { command: 'ruflo' } } },
    mcpJsonByProject: { '/r/b': { playwright: { command: 'npx', args: ['@playwright/mcp'] } } },
    needsAuth: { sentry: { timestamp: 1 } },
  });
  assert.deepEqual(rows.map((r) => [r.name, r.scope, r.projects, r.needsAuth]), [
    ['playwright', 'mcp.json', ['/r/b'], false],
    ['ruflo', 'project', ['/r/a', '/r/b'], false],
    ['sentry', 'global', [], true],
  ]);
  assert.equal(rows[0].args, 1);
});

test('mergeMcp: disabledIn/active reflect per-project disabled servers, global rows always active', () => {
  const base = {
    global: { sentry: { url: 'https://s/mcp' } },
    byProject: { '/r/a': { ruflo: { command: 'ruflo' } }, '/r/b': { ruflo: { command: 'ruflo' } } },
    mcpJsonByProject: {},
    needsAuth: {},
  };
  const partial = mergeMcp({ ...base, disabledByProject: { '/r/a': new Set(['ruflo']) } });
  const ruflo1 = partial.find((r) => r.name === 'ruflo');
  assert.deepEqual(ruflo1.disabledIn, ['/r/a']);
  assert.equal(ruflo1.active, true);
  const sentry1 = partial.find((r) => r.name === 'sentry');
  assert.deepEqual(sentry1.disabledIn, []);
  assert.equal(sentry1.active, true);

  const both = mergeMcp({ ...base, disabledByProject: { '/r/a': new Set(['ruflo']), '/r/b': new Set(['ruflo']) } });
  const ruflo2 = both.find((r) => r.name === 'ruflo');
  assert.deepEqual(ruflo2.disabledIn, ['/r/a', '/r/b']);
  assert.equal(ruflo2.active, false);
});

test('mergeMcp: unmatched needsAuth keys become claude.ai rows; matched keys do not duplicate', () => {
  const rows = mergeMcp({
    global: { sentry: { url: 'https://s/mcp' } },
    byProject: {},
    mcpJsonByProject: {},
    needsAuth: { sentry: { timestamp: 1 }, 'claude.ai Sentry': { timestamp: 1 } },
  });
  assert.equal(rows.length, 2);
  const extra = rows.find((r) => r.name === 'claude.ai Sentry');
  assert.equal(extra.scope, 'claude.ai');
  assert.equal(extra.needsAuth, true);
  assert.equal(extra.type, 'remote');
  assert.deepEqual(extra.projects, []);
  assert.deepEqual(extra.disabledIn, []);
  assert.equal(extra.active, true);

  const rows2 = mergeMcp({
    global: {},
    byProject: {},
    mcpJsonByProject: {},
    needsAuth: { 'claude.ai Sentry': { timestamp: 1 } },
  });
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].name, 'claude.ai Sentry');
});

test('mergeMcp tolerates a non-object server def without throwing', () => {
  assert.doesNotThrow(() => {
    const rows = mergeMcp({ global: { x: null }, byProject: {}, mcpJsonByProject: {}, needsAuth: {} });
    assert.deepEqual(rows.map((r) => [r.name, r.command, r.args, r.url]), [['x', null, 0, null]]);
  });
});

test('mergePlugins: id without @ uses the whole id as name with an empty marketplace', () => {
  const rows = mergePlugins({ standalone: [{ version: '1' }] }, {}, {});
  assert.equal(rows[0].name, 'standalone');
  assert.equal(rows[0].marketplace, '');
});

test('mergePlugins: unknown marketplace is never stale', () => {
  const rows = mergePlugins(
    { 'a@ghost-market': [{ version: '1', lastUpdated: '2026-08-01T00:00:00Z' }] },
    {}, {}, T0
  );
  assert.equal(rows[0].stale, false);
});

test('mergePlugins: malformed dates parse to null and are never stale', () => {
  const rows = mergePlugins(
    { 'a@m': [{ version: '1', lastUpdated: 'nope' }] },
    {}, { m: { lastUpdated: 'nope' } }, T0
  );
  assert.equal(rows[0].lastUpdated, null);
  assert.equal(rows[0].stale, false);
});

const { agentStatus, parseAgentMeta, resolveTeam, agentColor, nameFromFile } = require('../lib/teams');

test('agentStatus: active within 120s of the last write, else done', () => {
  const now = 1_000_000;
  assert.equal(agentStatus(now - 119_000, now), 'active');
  assert.equal(agentStatus(now - 120_001, now), 'done');
  assert.equal(agentStatus(null, now), 'done');
});

test('nameFromFile parses real agent file names (leading `a` after `agent-`)', () => {
  assert.equal(nameFromFile('agent-aimpl-task1-3a975d315ff6d0fe.meta.json'), 'impl-task1');
  assert.equal(nameFromFile('agent-ax-1234567890abcdef.meta.json'), 'x');
  assert.equal(nameFromFile('agent-aimpl-task3-3a975d315ff6d0fe.jsonl'), 'impl-task3');
  assert.equal(nameFromFile('agent-a2d1d0cfae35e53f6.jsonl'), null); // unnamed: 16 hex chars, no name prefix
});

test('parseAgentMeta tolerates missing fields and falls back through description, file name, then hash', () => {
  assert.deepEqual(
    parseAgentMeta({ name: 'final-review', agentType: 'final-review', model: 'opus[1m]', teamName: 'swps-v2', color: 'blue' }, 'agent-afinal-review-5c7b5c7b5c7b5c7b.meta.json'),
    { name: 'final-review', type: 'final-review', model: 'opus[1m]', color: 'blue', team: 'swps-v2', description: null }
  );
  assert.deepEqual(
    parseAgentMeta({}, 'agent-aimpl-task1-3a975d315ff6d0fe.meta.json'),
    { name: 'impl-task1', type: null, model: null, color: null, team: null, description: null }
  );
  assert.deepEqual(
    parseAgentMeta(null, 'agent-ax-1234567890abcdef.meta.json'),
    { name: 'x', type: null, model: null, color: null, team: null, description: null }
  );
  assert.deepEqual(
    parseAgentMeta({}, 'agent-aimpl-task3-3a975d315ff6d0fe.jsonl'),
    { name: 'impl-task3', type: null, model: null, color: null, team: null, description: null }
  );
  assert.deepEqual(
    parseAgentMeta({}, 'agent-a2d1d0cfae35e53f6.jsonl'),
    { name: '#2d1d0cfa', type: null, model: null, color: null, team: null, description: null }
  );
  assert.deepEqual(
    parseAgentMeta({ description: 'Scoped re-review of T6 fix' }, 'agent-a2d1d0cfae35e53f6.jsonl'),
    { name: 'Scoped re-review of T6 fix', type: null, model: null, color: null, team: null, description: 'Scoped re-review of T6 fix' }
  );
  assert.deepEqual(
    parseAgentMeta({ name: 'x', description: 'd' }, 'agent-a2d1d0cfae35e53f6.jsonl'),
    { name: 'x', type: null, model: null, color: null, team: null, description: 'd' }
  );
});

test('resolveTeam prefers agent metadata, then the lead session, ignoring auto teams', () => {
  const teams = [
    { name: 'swps-v2', leadSessionId: 'lead-1' },
    { name: 'session-9b5fb426', leadSessionId: 'lead-2' },
  ];
  assert.equal(resolveTeam([{ team: 'swps-v2' }], teams, 'other'), 'swps-v2');
  assert.equal(resolveTeam([{ team: null }], teams, 'lead-1'), 'swps-v2');
  assert.equal(resolveTeam([{ team: 'session-9b5fb426' }], teams, 'lead-2'), null);
  assert.equal(resolveTeam([], teams, 'nobody'), null);
});

test('agentColor maps known names and falls back to muted', () => {
  assert.equal(agentColor('blue'), '#4a90e2');
  assert.equal(agentColor('nope'), 'var(--muted)');
  assert.equal(agentColor(null), 'var(--muted)');
});

const { overdueWaits } = require('../lib/notify');

test('overdueWaits: only waits past the threshold that have not been nagged', () => {
  const now = 10_000_000;
  const since = new Map([['a', now - 61 * 60000], ['b', now - 30 * 60000], ['c', now - 90 * 60000]]);
  assert.deepEqual(overdueWaits(now, since, 60 * 60000, new Set()), ['c', 'a']);
  assert.deepEqual(overdueWaits(now, since, 60 * 60000, new Set(['c'])), ['a']);
});

test('overdueWaits: threshold 0 or less disables the nag', () => {
  const now = 10_000_000;
  const since = new Map([['a', now - 5 * 3600000]]);
  assert.deepEqual(overdueWaits(now, since, 0, new Set()), []);
  assert.deepEqual(overdueWaits(now, since, -1, new Set()), []);
});

test('overdueWaits: exactly at the threshold counts as overdue', () => {
  const now = 10_000_000;
  assert.deepEqual(overdueWaits(now, new Map([['a', now - 60000]]), 60000, new Set()), ['a']);
});

const { trackWaits } = require('../lib/notify');

test('trackWaits: first sight of a waiting session sets the clock to now', () => {
  const waitingSince = new Map();
  const idleNotified = new Set();
  trackWaits(new Map([['a', 'waiting']]), waitingSince, idleNotified, 1000);
  assert.deepEqual([...waitingSince], [['a', 1000]]);
});

test('trackWaits: a repeated poll keeps the original timestamp', () => {
  const waitingSince = new Map([['a', 1000]]);
  const idleNotified = new Set();
  trackWaits(new Map([['a', 'waiting']]), waitingSince, idleNotified, 5000);
  assert.deepEqual([...waitingSince], [['a', 1000]]);
});

test('trackWaits: busy, shell, or unknown status clears both collections', () => {
  for (const status of ['busy', 'shell', 'unknown']) {
    const waitingSince = new Map([['a', 1000]]);
    const idleNotified = new Set(['a']);
    trackWaits(new Map([['a', status]]), waitingSince, idleNotified, 5000);
    assert.deepEqual([...waitingSince], []);
    assert.deepEqual([...idleNotified], []);
  }
});

test('trackWaits: a session absent from next clears both collections', () => {
  const waitingSince = new Map([['a', 1000]]);
  const idleNotified = new Set(['a']);
  trackWaits(new Map(), waitingSince, idleNotified, 5000);
  assert.deepEqual([...waitingSince], []);
  assert.deepEqual([...idleNotified], []);
});

test('trackWaits: re-entry after a bounce starts a fresh clock', () => {
  const waitingSince = new Map([['a', 1000]]);
  const idleNotified = new Set(['a']);
  trackWaits(new Map([['a', 'busy']]), waitingSince, idleNotified, 2000);
  trackWaits(new Map([['a', 'waiting']]), waitingSince, idleNotified, 3000);
  assert.deepEqual([...waitingSince], [['a', 3000]]);
  assert.ok(waitingSince.get('a') > 1000);
});

// --- managed settings location ---
const { managedSettingsPath } = require('../lib/paths');

test('managedSettingsPath is per platform and never under the home dir', () => {
  assert.equal(managedSettingsPath('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.equal(managedSettingsPath('linux'), '/etc/claude-code/managed-settings.json');
  assert.equal(managedSettingsPath('win32'), 'C:/Program Files/ClaudeCode/managed-settings.json');
  assert.ok(!managedSettingsPath('darwin').includes('.claude'));
});

// --- burn rate, cache hit ratio, top-N ---
const { burnRate, cacheHitRatio, topByCost } = require('../lib/pricing');

test('burnRate is null until five minutes in, then whole dollars per hour (null under $1/h)', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(burnRate(1, t0, t0 + 4 * 60000 + 59000), null);
  assert.equal(burnRate(1, t0, t0 + 5 * 60000), 12);         // $1 in 5 min = $12/h
  assert.equal(burnRate(1, t0, t0 + 30 * 60000), 2);         // $1 in 30 min
  assert.equal(burnRate(0.123, t0, t0 + 60 * 60000), null);  // under $1/h
  assert.equal(burnRate(1.6, t0, t0 + 60 * 60000), 2);      // whole dollars
  assert.equal(burnRate(null, t0, t0 + 3600000), null);
  assert.equal(burnRate(0, t0, t0 + 3600000), null);
  assert.equal(burnRate(1, null, t0), null);
  assert.equal(burnRate(1, undefined, t0), null);
});

test('cacheHitRatio is cache reads over all input-side tokens, null when there are none', () => {
  assert.equal(cacheHitRatio({ m: { input: 10, output: 500, cacheRead: 90, cacheCreation: 0 } }), 0.9);
  assert.equal(cacheHitRatio({
    a: { input: 10, output: 0, cacheRead: 0, cacheCreation: 10 },
    b: { input: 0, output: 0, cacheRead: 20, cacheCreation: 0 },
  }), 0.5);
  assert.equal(cacheHitRatio({ m: { input: 0, output: 999, cacheRead: 0, cacheCreation: 0 } }), null);
  assert.equal(cacheHitRatio({}), null);
  assert.equal(cacheHitRatio(null), null);
});

test('topByCost sorts descending, caps at n, drops sub-cent entries, leaves input untouched', () => {
  const items = [{ id: 'a', cost: 1 }, { id: 'b', cost: 3 }, { id: 'c', cost: 0.004 }, { id: 'd', cost: 2 }];
  assert.deepEqual(topByCost(items, 2).map((i) => i.id), ['b', 'd']);
  assert.deepEqual(topByCost(items).map((i) => i.id), ['b', 'd', 'a']);
  assert.equal(items[0].id, 'a'); // not sorted in place
  assert.deepEqual(topByCost([], 5), []);
});

// --- per-session usage breakdown ---
const { usageBreakdown } = require('../lib/transcripts');

test('usageBreakdown: per model sorted by cost, subagent share, cache ratio, unpriced flag', () => {
  const meta = {
    usage: {
      'claude-opus-5-5': { input: 1e6, output: 0, cacheRead: 1e6, cacheCreation: 0 },  // 4 + 0.2 = 4.2
      'mystery': { input: 0, output: 1e5, cacheRead: 0, cacheCreation: 0 },            // 2.5 at fallback
    },
    subagentCount: 2,
    subagentUsage: { 'claude-haiku-5-5': { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 } }, // 0.1
  };
  const u = usageBreakdown(meta);
  assert.equal(u.cost, 6.8);
  assert.equal(u.tokens, 3_100_000);
  assert.deepEqual(u.byModel.map((r) => r.model), ['claude-opus-5-5', 'mystery', 'claude-haiku-5-5']);
  assert.equal(u.byModel[0].cost, 4.2);
  assert.equal(u.byModel[0].cacheRead, 1e6);
  assert.deepEqual(u.subagents, { count: 2, cost: 0.1, tokens: 1e6 });
  assert.equal(u.cacheHitRatio, 1e6 / 3e6);
  assert.deepEqual(u.assumedModels, ['mystery']);
  assert.equal(u.context, null);
  assert.equal(u.tools, null);
  const withCtx = usageBreakdown({ ...meta, context: { tokens: 420_600, model: 'claude-opus-5-5' }, tools: { Bash: { count: 3, errors: 1 } } });
  assert.deepEqual(withCtx.context, { tokens: 421_000, window: 1_000_000, pct: 42 });
  assert.deepEqual(withCtx.tools, { total: 3, errors: 1, byName: [{ name: 'Bash', count: 3, errors: 1 }] });
});

test('usageBreakdown is null for a session with no usage and has no subagents block without them', () => {
  assert.equal(usageBreakdown({ usage: {} }), null);
  assert.equal(usageBreakdown({}), null);
  const u = usageBreakdown({ usage: { 'claude-sonnet-5-5': { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 } } });
  assert.equal(u.subagents, null);
  assert.equal(u.cost, 0);           // $0.002 rounds to 0.00 — the UI shows "$0.00"
  assert.equal(u.cacheHitRatio, 0);
});

// --- markdown directory helpers ---
const fsSync = require('fs');
const osMod = require('os');
const pathMod = require('path');
const { frontmatterDescription, listAgents, listSkills } = require('../lib/mdfiles');

test('frontmatterDescription reads the description line of YAML frontmatter', () => {
  assert.equal(frontmatterDescription('---\nname: x\ndescription: "Does a thing"\n---\nbody'), 'Does a thing');
  assert.equal(frontmatterDescription('---\ndescription: plain\n---\n'), 'plain');
  assert.equal(frontmatterDescription('no frontmatter'), null);
  assert.equal(frontmatterDescription('---\nname: only\n---\n'), null);
  assert.equal(frontmatterDescription(''), null);
});

test('listAgents and listSkills read names and descriptions, tolerate missing dirs', async () => {
  const tmp = fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dash-md-'));
  fsSync.mkdirSync(pathMod.join(tmp, 'agents'));
  fsSync.writeFileSync(pathMod.join(tmp, 'agents', 'reviewer.md'), '---\ndescription: Reviews code\n---\n');
  fsSync.writeFileSync(pathMod.join(tmp, 'agents', 'notes.txt'), 'ignored');
  fsSync.mkdirSync(pathMod.join(tmp, 'skills', 'tdd'), { recursive: true });
  fsSync.writeFileSync(pathMod.join(tmp, 'skills', 'tdd', 'SKILL.md'), '---\ndescription: Red green\n---\n');
  fsSync.mkdirSync(pathMod.join(tmp, 'skills', 'empty'));
  const agents = await listAgents(pathMod.join(tmp, 'agents'));
  assert.deepEqual(agents, [{ name: 'reviewer', description: 'Reviews code' }]);
  const skills = await listSkills(pathMod.join(tmp, 'skills'));
  assert.deepEqual(skills, [{ name: 'tdd', description: 'Red green' }]);
  assert.deepEqual(await listAgents(pathMod.join(tmp, 'nope')), []);
  assert.deepEqual(await listSkills(pathMod.join(tmp, 'agents', 'reviewer.md')), []); // a file, not a dir
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

// --- toolset resolvers ---
const { parseDenyRules, resolvePlugins, resolveAgents, resolveSkills, pluginShortName } = require('../lib/toolset');

function scopesOf(partial) {
  return { managed: null, local: null, project: null, user: null, ...partial };
}

test('parseDenyRules reads Agent/Task/Skill rules, tolerates spaces, quotes, and junk', () => {
  const r = parseDenyRules(['Agent(reviewer)', 'Task( planner )', 'Skill("tdd")', "Agent('x')", 'Bash(rm:*)', 42, null]);
  assert.deepEqual([...r.agents].sort(), ['planner', 'reviewer', 'x']);
  assert.deepEqual([...r.skills], ['tdd']);
  assert.deepEqual([...parseDenyRules(undefined).agents], []);
  assert.deepEqual([...parseDenyRules('Agent(a)').agents], []); // not an array
});

test('pluginShortName strips the marketplace suffix', () => {
  assert.equal(pluginShortName('ecc@claude-plugins-official'), 'ecc');
  assert.equal(pluginShortName('bare'), 'bare');
});

test('resolvePlugins: local overrides project overrides user; unmentioned installed is off/default; mentioned-not-installed is listed', () => {
  const rows = [
    { id: 'a@m', name: 'a', installed: true, enabled: true, stale: false, installPath: '/p/a' },
    { id: 'b@m', name: 'b', installed: true, enabled: false, stale: true, installPath: '/p/b' },
    { id: 'c@m', name: 'c', installed: true, enabled: false, stale: false, installPath: '/p/c' },
  ];
  const scopes = scopesOf({
    user: { enabledPlugins: { 'a@m': true, 'b@m': true, 'ghost@m': true } },
    project: { enabledPlugins: { 'b@m': false } },
    local: { enabledPlugins: { 'a@m': false } },
  });
  const out = resolvePlugins(rows, scopes);
  const by = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.equal(by.a.enabled, false); assert.equal(by.a.decidedBy, 'local');
  assert.equal(by.b.enabled, false); assert.equal(by.b.decidedBy, 'project');
  assert.equal(by.c.enabled, false); assert.equal(by.c.decidedBy, 'default');
  assert.equal(by.ghost.enabled, true); assert.equal(by.ghost.decidedBy, 'user'); assert.equal(by.ghost.installed, false);
  assert.equal(by.a.kind, 'plugin'); assert.equal(by.a.source, 'user'); assert.equal(by.a.pluginId, 'a@m');
  assert.deepEqual(out.map((r) => r.name), ['ghost', 'a', 'b', 'c']); // enabled first, then name
});

test('resolvePlugins: a managed scope beats everything; null scopes are fine', () => {
  const rows = [{ id: 'a@m', name: 'a', installed: true, enabled: true, stale: false, installPath: null }];
  const out = resolvePlugins(rows, scopesOf({ managed: { enabledPlugins: { 'a@m': false } }, local: { enabledPlugins: { 'a@m': true } } }));
  assert.equal(out[0].enabled, false); assert.equal(out[0].decidedBy, 'managed');
  assert.equal(resolvePlugins(rows, scopesOf({}))[0].decidedBy, 'default');
});

test('resolveAgents: project shadows user shadows plugin; deny in any scope wins at the highest scope', () => {
  const candidates = [
    { name: 'reviewer', source: 'plugin', pluginId: 'ecc@m', description: 'plugin one' },
    { name: 'reviewer', source: 'user', pluginId: null, description: 'user one' },
    { name: 'reviewer', source: 'project', pluginId: null, description: 'project one' },
    { name: 'planner', source: 'user', pluginId: null, description: null },
    { name: 'scout', source: 'plugin', pluginId: 'ecc@m', description: null },
  ];
  const scopes = scopesOf({
    user: { permissions: { deny: ['Agent(planner)'] } },
    local: { permissions: { deny: ['Task(planner)', 'Agent(ecc:scout)'] } },
  });
  const out = resolveAgents(candidates, scopes);
  const by = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.equal(by.reviewer.source, 'project');
  assert.equal(by.reviewer.description, 'project one');
  assert.deepEqual(by.reviewer.shadowed, ['user', 'plugin:ecc']);
  assert.equal(by.reviewer.enabled, true); assert.equal(by.reviewer.decidedBy, 'default');
  assert.equal(by.planner.enabled, false); assert.equal(by.planner.decidedBy, 'local'); // highest scope that denies
  assert.equal(by.scout.enabled, false); assert.equal(by.scout.decidedBy, 'local'); // namespaced match
  assert.equal(by.scout.pluginId, 'ecc@m'); assert.equal(by.scout.source, 'plugin');
  assert.deepEqual(out.map((r) => r.name), ['reviewer', 'planner', 'scout']); // enabled first, then name
});

test('resolveAgents: a deny on a shadowed name disables the winner, never falls back to the loser', () => {
  const out = resolveAgents([
    { name: 'x', source: 'project', pluginId: null, description: null },
    { name: 'x', source: 'plugin', pluginId: 'p@m', description: null },
  ], scopesOf({ project: { permissions: { deny: ['Agent(x)'] } } }));
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'project'); assert.equal(out[0].enabled, false); assert.deepEqual(out[0].shadowed, ['plugin:p']);
});

test('resolveSkills: overrides by highest scope, deny rules, plugin skills follow the plugin', () => {
  const candidates = [
    { name: 'tdd', source: 'project', pluginId: null, description: null },
    { name: 'brainstorm', source: 'user', pluginId: null, description: null },
    { name: 'quiet', source: 'user', pluginId: null, description: null },
    { name: 'denied', source: 'user', pluginId: null, description: null },
    { name: 'plug-on', source: 'plugin', pluginId: 'on@m', description: null },
    { name: 'plug-off', source: 'plugin', pluginId: 'off@m', description: null },
  ];
  const scopes = scopesOf({
    user: { skillOverrides: { tdd: 'off', brainstorm: 'name-only' } },
    local: { skillOverrides: { tdd: 'on' }, permissions: { deny: ['Skill(denied)'] } },
  });
  const pluginRows = [
    { name: 'on', pluginId: 'on@m', enabled: true }, { name: 'off', pluginId: 'off@m', enabled: false },
  ];
  const out = resolveSkills(candidates, scopes, pluginRows);
  const by = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.equal(by.tdd.enabled, true); assert.equal(by.tdd.decidedBy, 'local'); assert.equal(by.tdd.mode, 'on');
  assert.equal(by.brainstorm.enabled, true); assert.equal(by.brainstorm.mode, 'name-only'); assert.equal(by.brainstorm.decidedBy, 'user');
  assert.equal(by.quiet.enabled, true); assert.equal(by.quiet.decidedBy, 'default'); assert.equal(by.quiet.mode, null);
  assert.equal(by.denied.enabled, false); assert.equal(by.denied.decidedBy, 'local');
  assert.equal(by['plug-on'].enabled, true); assert.equal(by['plug-on'].decidedBy, 'plugin');
  assert.equal(by['plug-off'].enabled, false); assert.equal(by['plug-off'].decidedBy, 'plugin');
  assert.equal(by.tdd.kind, 'skill');
});

test('resolveSkills: a Skill deny disables a plugin skill by bare or namespaced name', () => {
  const out = resolveSkills([
    { name: 'a', source: 'plugin', pluginId: 'p@m' },
    { name: 'b', source: 'plugin', pluginId: 'p@m' },
  ], { managed: null, local: { permissions: { deny: ['Skill(a)', 'Skill(p:b)'] } }, project: null, user: null },
  [{ pluginId: 'p@m', enabled: true }]);
  assert.equal(out.length, 2);
  for (const r of out) { assert.equal(r.enabled, false); assert.equal(r.decidedBy, 'local'); }
});

// --- toolset: mcp, audit, recipes ---
const { resolveMcp, auditToolset, recipeFor } = require('../lib/toolset');

test('resolveMcp keeps global rows and rows used by this project, with disabledIn applied', () => {
  const root = '/Users/me/proj';
  const mcp = [
    { name: 'gh', scope: 'global', projects: [], disabledIn: [], needsAuth: false, active: true },
    { name: 'db', scope: 'project', projects: [root], disabledIn: [root], needsAuth: true, active: false },
    { name: 'other', scope: 'project', projects: ['/Users/me/other'], disabledIn: [], needsAuth: false, active: true },
    { name: 'shared', scope: 'mcp.json', projects: ['/users/ME/PROJ'], disabledIn: [], needsAuth: false, active: true },
  ];
  const out = resolveMcp(mcp, root);
  assert.deepEqual(out.map((r) => r.name), ['gh', 'shared', 'db']); // enabled first, then name
  const by = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.equal(by.gh.enabled, true); assert.equal(by.gh.source, 'global'); assert.equal(by.gh.decidedBy, 'default');
  assert.equal(by.db.enabled, false); assert.equal(by.db.decidedBy, 'claude.json'); assert.equal(by.db.needsAuth, true);
  assert.equal(by.shared.source, 'mcp.json'); assert.equal(by.db.kind, 'mcp');
});

test('auditToolset produces one finding per condition', () => {
  const ts = {
    plugins: [
      { name: 'ghost', kind: 'plugin', enabled: true, installed: false, stale: false, decidedBy: 'user' },
      { name: 'old', kind: 'plugin', enabled: true, installed: true, stale: true, decidedBy: 'user' },
      { name: 'fine', kind: 'plugin', enabled: true, installed: true, stale: false, decidedBy: 'user' },
    ],
    agents: [
      { name: 'r', kind: 'agent', enabled: true, source: 'project', shadowed: ['plugin:ecc'], decidedBy: 'default' },
    ],
    skills: [],
    mcp: [{ name: 'gh', kind: 'mcp', enabled: true, needsAuth: true }],
    denyUnmatched: { agents: ['vanished'], skills: [] },
  };
  const f = auditToolset(ts, ['.claude/settings.local.json']);
  const texts = f.map((x) => x.text);
  assert.ok(texts.some((t) => t.includes('ghost') && t.includes('not installed')), texts);
  assert.ok(texts.some((t) => t.includes('old') && t.includes('stale')), texts);
  assert.ok(texts.some((t) => t.includes('gh') && t.includes('needs auth')), texts);
  assert.ok(texts.some((t) => t.includes('vanished') && t.includes('deny')), texts);
  assert.ok(texts.some((t) => t.includes('r') && t.includes('shadows')), texts);
  assert.ok(texts.some((t) => t.includes('settings.local.json') && t.includes('unreadable')), texts);
  assert.equal(f.filter((x) => x.level === 'warn').length, 5);
  assert.equal(f.find((x) => x.text.includes('shadows')).level, 'info');
  assert.deepEqual(auditToolset({ plugins: [], agents: [], skills: [], mcp: [], denyUnmatched: { agents: [], skills: [] } }), []);
});

test('recipeFor gives a settings.local.json snippet for plugins, agents, skills and a sentence for MCP', () => {
  const root = '/p';
  const plugOn = recipeFor({ kind: 'plugin', pluginId: 'ecc@m', enabled: true }, root);
  assert.equal(plugOn.target, '.claude/settings.local.json');
  assert.deepEqual(JSON.parse(plugOn.text), { enabledPlugins: { 'ecc@m': false } });
  assert.ok(plugOn.label.toLowerCase().includes('disable'));
  const plugOff = recipeFor({ kind: 'plugin', pluginId: 'ecc@m', enabled: false }, root);
  assert.deepEqual(JSON.parse(plugOff.text), { enabledPlugins: { 'ecc@m': true } });
  const agentOn = recipeFor({ kind: 'agent', name: 'reviewer', source: 'plugin', pluginId: 'ecc@m', enabled: true }, root);
  assert.deepEqual(JSON.parse(agentOn.text), { permissions: { deny: ['Agent(ecc:reviewer)'] } });
  const agentOff = recipeFor({ kind: 'agent', name: 'planner', source: 'user', pluginId: null, enabled: false, decidedBy: 'local' }, root);
  assert.ok(agentOff.text.includes('Agent(planner)') && agentOff.text.includes('.claude/settings.local.json'), agentOff.text);
  assert.equal(agentOff.target, '.claude/settings.local.json');
  const agentOffUser = recipeFor({ kind: 'agent', name: 'planner', source: 'user', pluginId: null, enabled: false, decidedBy: 'user' }, root);
  assert.ok(agentOffUser.text.includes('user settings'), agentOffUser.text);
  const skill = recipeFor({ kind: 'skill', name: 'tdd', source: 'user', enabled: true }, root);
  assert.deepEqual(JSON.parse(skill.text), { skillOverrides: { tdd: 'off' } });
  const pskill = recipeFor({ kind: 'skill', name: 'x', source: 'plugin', pluginId: 'ecc@m', enabled: true }, root);
  assert.deepEqual(JSON.parse(pskill.text), { enabledPlugins: { 'ecc@m': false } }); // plugin skills flip via the plugin
  const pskillDenyLocal = recipeFor({ kind: 'skill', name: 'x', source: 'plugin', pluginId: 'ecc@m', enabled: false, decidedBy: 'local' }, root);
  assert.ok(pskillDenyLocal.text.includes('Skill(ecc:x)') && pskillDenyLocal.text.includes('.claude/settings.local.json'), pskillDenyLocal.text);
  const pskillDenyUser = recipeFor({ kind: 'skill', name: 'x', source: 'plugin', pluginId: 'ecc@m', enabled: false, decidedBy: 'user' }, root);
  assert.ok(pskillDenyUser.text.includes('user settings'), pskillDenyUser.text);
  const mcp = recipeFor({ kind: 'mcp', name: 'gh', source: 'global', enabled: true }, root);
  assert.ok(mcp.text.startsWith('Run /mcp inside a Claude session in this project and toggle gh'), mcp.text);
  assert.equal(mcp.target, 'a Claude session in this project');
  const mj = recipeFor({ kind: 'mcp', name: 'shared', source: 'mcp.json', enabled: true }, root);
  assert.deepEqual(JSON.parse(mj.text), { disabledMcpjsonServers: ['shared'] });
});

// --- toolset readers (with injected I/O) ---
const { readScopes, collectCandidates, denyUnmatched } = require('../lib/toolset');

test('readScopes maps the four files to scopes, flags invalid JSON, treats missing as null', async () => {
  const seen = [];
  const reader = async (abs) => {
    seen.push(abs);
    if (abs.endsWith('managed-settings.json')) return 'missing';
    if (abs.endsWith('/.claude/settings.local.json')) return 'invalid';
    if (abs.endsWith('/.claude/settings.json') && abs.startsWith('/p/')) return { enabledPlugins: { 'a@m': true } };
    return { permissions: { deny: ['Agent(x)'] } }; // user
  };
  const r = await readScopes('/p', reader);
  assert.equal(r.scopes.managed, null);
  assert.equal(r.scopes.local, null);
  assert.deepEqual(r.scopes.project, { enabledPlugins: { 'a@m': true } });
  assert.deepEqual(r.scopes.user, { permissions: { deny: ['Agent(x)'] } });
  assert.deepEqual(r.files, { managed: false, local: true, project: true, user: true });
  assert.deepEqual(r.unreadable, ['.claude/settings.local.json']);
  assert.ok(seen.some((p) => p === '/p/.claude/settings.local.json'));
  assert.ok(seen.some((p) => p === '/p/.claude/settings.json'));
});

test('readScopes survives a reader that throws', async () => {
  const r = await readScopes('/p', async () => { throw new Error('boom'); });
  assert.deepEqual(r.scopes, { managed: null, local: null, project: null, user: null });
  assert.equal(r.unreadable.length, 0);
});

test('collectCandidates gathers project, user, and enabled-plugin agents and skills; tolerates failing listers', async () => {
  const calls = [];
  const listers = {
    listAgents: async (dir) => {
      calls.push(dir);
      if (dir === '/p/.claude/agents') return [{ name: 'local-agent', description: 'd' }];
      if (dir.endsWith('/.claude/agents')) return [{ name: 'user-agent', description: null }];
      if (dir === '/plug/on/agents') return [{ name: 'plug-agent', description: null }];
      throw new Error('unreadable');
    },
    listSkills: async (dir) => {
      if (dir === '/p/.claude/skills') return [{ name: 'local-skill', description: null }];
      if (dir === '/plug/on/skills') return [{ name: 'plug-skill', description: null }];
      return [];
    },
  };
  const pluginRows = [
    { pluginId: 'on@m', enabled: true, installed: true, installPath: '/plug/on' },
    { pluginId: 'off@m', enabled: false, installed: true, installPath: '/plug/off' },
    { pluginId: 'nopath@m', enabled: true, installed: true, installPath: null },
  ];
  const c = await collectCandidates('/p', pluginRows, listers);
  assert.deepEqual(c.agents.map((a) => `${a.source}:${a.name}`).sort(), ['plugin:plug-agent', 'project:local-agent', 'user:user-agent']);
  assert.equal(c.agents.find((a) => a.source === 'plugin').pluginId, 'on@m');
  assert.deepEqual(c.skills.map((s) => `${s.source}:${s.name}`).sort(), ['plugin:plug-skill', 'project:local-skill']);
  assert.ok(!calls.includes('/plug/off/agents'), 'disabled plugins are not listed');
  assert.ok(!calls.some((d) => d.startsWith('null')), 'missing installPath is skipped');
});

test('denyUnmatched lists deny-rule names that no row defines', () => {
  const scopes = { managed: null, local: { permissions: { deny: ['Agent(ghost)', 'Agent(ecc:scout)', 'Skill(none)'] } }, project: null, user: { permissions: { deny: ['Agent(real)'] } } };
  const agents = [{ name: 'real', source: 'user', pluginId: null }, { name: 'scout', source: 'plugin', pluginId: 'ecc@m' }];
  const skills = [{ name: 'tdd', source: 'user' }];
  assert.deepEqual(denyUnmatched(scopes, agents, skills), { agents: ['ghost'], skills: ['none'] });
});

// --- reveal a settings file ---
const { revealTarget, revealCommand } = require('../lib/opener');

test('revealTarget maps the three allowed keys and rejects everything else', () => {
  assert.equal(revealTarget('local'), '.claude/settings.local.json');
  assert.equal(revealTarget('project'), '.claude/settings.json');
  assert.equal(revealTarget('mcpJson'), '.mcp.json');
  assert.equal(revealTarget('../../etc/passwd'), null);
  assert.equal(revealTarget(''), null);
  assert.equal(revealTarget(undefined), null);
  assert.equal(revealTarget('LOCAL'), null);
  assert.equal(revealTarget('constructor'), null);
});

test('revealCommand is per platform and never interpolates into a shell string', () => {
  assert.deepEqual(revealCommand('darwin', '/p/.claude/settings.json'), ['open', ['-R', '/p/.claude/settings.json']]);
  assert.deepEqual(revealCommand('win32', 'C:/p/.mcp.json'), ['explorer', ['/select,C:/p/.mcp.json']]);
  assert.deepEqual(revealCommand('linux', '/p/.claude/settings.json'), ['xdg-open', ['/p/.claude']]);
  const [, args] = revealCommand('darwin', "/p/it's; rm -rf /");
  assert.equal(args[1], "/p/it's; rm -rf /"); // passed as one argv entry, untouched
});

// --- toolset: final-review fixes ---
{
  const tsm = require('../lib/toolset');

  test('denyUnmatched honours namespaced Skill(plugin:name) rules for plugin skills', () => {
    const scopes = { local: { permissions: { deny: ['Skill(p:b)'] } } };
    const out = tsm.denyUnmatched(scopes, [], [{ name: 'b', source: 'plugin', pluginId: 'p@m' }]);
    assert.deepEqual(out.skills, []);
  });

  test('recipeFor: a deny-disabled user skill is told to remove the deny entry', () => {
    const scopes = { local: { permissions: { deny: ['Skill(x)'] } } };
    const [row] = tsm.resolveSkills([{ name: 'x', source: 'user' }], scopes, []);
    assert.equal(row.enabled, false);
    assert.equal(row.deniedBy, 'local');
    const rec = tsm.recipeFor(row, '/p');
    assert.ok(rec.text.includes('Skill(x)') && rec.text.includes('.claude/settings.local.json'), rec.text);
  });

  test('recipeFor: an override-off skill still gets the skillOverrides "on" snippet', () => {
    const scopes = { local: { skillOverrides: { x: 'off' } } };
    const [row] = tsm.resolveSkills([{ name: 'x', source: 'user' }], scopes, []);
    assert.equal(row.enabled, false);
    assert.equal(row.deniedBy, null);
    const rec = tsm.recipeFor(row, '/p');
    assert.deepEqual(JSON.parse(rec.text), { skillOverrides: { x: 'on' } });
  });

  const mroot = '/Users/me/proj';
  const mrow = (disabledIn = []) => [{ name: 'srv', scope: 'mcp.json', projects: [mroot], disabledIn, needsAuth: false }];

  test('resolveMcp: a settings veto turns an .mcp.json server off, and the recipe removes the veto', () => {
    const [r] = tsm.resolveMcp(mrow(), mroot, { local: { disabledMcpjsonServers: ['srv'] } });
    assert.equal(r.enabled, false);
    assert.equal(r.decidedBy, 'local');
    const rec = tsm.recipeFor(r, mroot);
    assert.equal(rec.text, 'Remove "srv" from disabledMcpjsonServers in .claude/settings.local.json.');
  });

  test('resolveMcp: enabledMcpjsonServers approves an .mcp.json server disabled in claude.json', () => {
    const [r] = tsm.resolveMcp(mrow([mroot]), mroot, { project: { enabledMcpjsonServers: ['srv'] } });
    assert.equal(r.enabled, true);
    assert.equal(r.decidedBy, 'project');
  });

  test('resolveMcp: enableAllProjectMcpServers approves', () => {
    const [r] = tsm.resolveMcp(mrow([mroot]), mroot, { user: { enableAllProjectMcpServers: true } });
    assert.equal(r.enabled, true);
    assert.equal(r.decidedBy, 'user');
  });

  test('resolveMcp: a veto beats an approval at a lower scope, and non-arrays are ignored', () => {
    const scopes = { local: { disabledMcpjsonServers: ['srv'] }, user: { enabledMcpjsonServers: ['srv'] } };
    const [r] = tsm.resolveMcp(mrow(), mroot, scopes);
    assert.equal(r.enabled, false);
    assert.equal(r.decidedBy, 'local');
    const [q] = tsm.resolveMcp(mrow(), mroot, { local: { disabledMcpjsonServers: 'srv' } });
    assert.equal(q.enabled, true);
  });

  test('resolveMcp: omitting scopes keeps the disabledIn behaviour', () => {
    const [r] = tsm.resolveMcp(mrow([mroot]), mroot);
    assert.equal(r.enabled, false);
    assert.equal(r.decidedBy, 'claude.json');
  });
}

// --- context window sizes ---
const { contextWindow } = require('../lib/pricing');

test('contextWindow: 1M for current families, 200K for Haiku 4.5, older and unknown', () => {
  for (const id of ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8',
    'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5',
    'opus', 'sonnet', 'haiku', 'us.anthropic.claude-sonnet-4-6-v1:0', 'claude-opus-4-8@20260101']) {
    assert.equal(contextWindow(id), 1_000_000, id);
  }
  for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-3-5-haiku', 'mystery', '', null, undefined]) {
    assert.equal(contextWindow(id), 200_000, String(id));
  }
});

// --- scanner: context size and tool counts ---
const { TOOL_RING } = require('../lib/transcripts');

function toolUseLine({ id, model = 'claude-opus-5-5', usage, blocks }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: AUG10,
    message: { id, model, usage, content: blocks },
  });
}
function toolResultLine(results) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: results } });
}
const U = { input_tokens: 10, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2_000, output_tokens: 50 };

test('scanLine records the prompt size of the latest assistant message once per message id', () => {
  const scan = freshScan();
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'text', text: 'hi' }] }), scan);
  assert.deepEqual(scan.lastContext && { tokens: scan.lastContext.tokens, model: scan.lastContext.model },
    { tokens: 402_010, model: 'claude-opus-5-5' });
  // a second record of the same message (next content block) does not move it or double count usage
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }), scan);
  assert.equal(scan.lastContext.tokens, 402_010);
  assert.equal(scan.usage['claude-opus-5-5'].cacheRead, 400_000);
  const U2 = { ...U, cache_read_input_tokens: 500_000 };
  scanLine(toolUseLine({ id: 'm2', usage: U2, blocks: [] }), scan);
  assert.equal(scan.lastContext.tokens, 502_010);
});

test('scanLine counts tool_use blocks by name across records sharing a message id, each id once', () => {
  const scan = freshScan();
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }), scan);
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] }), scan);
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }), scan); // replayed line
  assert.deepEqual(scan.tools, { Bash: { count: 1, errors: 0 }, Read: { count: 1, errors: 0 } });
});

test('scanLine attributes failed tool results by id; unknown ids land in "(unknown)"', () => {
  const scan = freshScan();
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }), scan);
  scanLine(toolResultLine([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }]), scan);
  scanLine(toolResultLine([{ type: 'tool_result', tool_use_id: 'never-seen', is_error: true, content: 'x' }]), scan);
  scanLine(toolResultLine([{ type: 'tool_result', tool_use_id: 't1', content: 'fine' }]), scan); // not an error
  assert.deepEqual(scan.tools.Bash, { count: 1, errors: 1 });
  assert.deepEqual(scan.tools['(unknown)'], { count: 0, errors: 1 });
});

test('the tool id ring keeps the last TOOL_RING ids; older ids fall to "(unknown)"', () => {
  const scan = freshScan();
  for (let i = 0; i < TOOL_RING + 5; i++) {
    scanLine(toolUseLine({ id: `m${i}`, usage: U, blocks: [{ type: 'tool_use', id: `t${i}`, name: 'Grep', input: {} }] }), scan);
  }
  assert.equal(scan.toolIds.length, TOOL_RING);
  scanLine(toolResultLine([{ type: 'tool_result', tool_use_id: 't0', is_error: true }]), scan); // evicted
  scanLine(toolResultLine([{ type: 'tool_result', tool_use_id: `t${TOOL_RING + 4}`, is_error: true }]), scan); // newest
  assert.equal(scan.tools.Grep.count, TOOL_RING + 5);
  assert.equal(scan.tools.Grep.errors, 1);
  assert.equal(scan.tools['(unknown)'].errors, 1);
});

test('scanLine still buckets your reply time: a tool-result record does not consume the pending assistant mark', () => {
  const scan = freshScan();
  scanLine(toolUseLine({ id: 'm1', usage: U, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }), scan);
  const pending = scan.lastAssistantTs;
  scanLine(toolResultLine([{ type: 'tool_result', tool_use_id: 't1', is_error: true }]), scan);
  assert.equal(scan.lastAssistantTs, pending);
});

// --- context and tool summaries ---
const { contextSummary, toolSummary } = require('../lib/transcripts');

test('contextSummary rounds tokens to the nearest thousand, caps pct at 100, handles missing input', () => {
  assert.deepEqual(contextSummary({ tokens: 412_345, model: 'claude-opus-5-5' }), { tokens: 412_000, window: 1_000_000, pct: 41 });
  assert.deepEqual(contextSummary({ tokens: 150_499, model: 'claude-haiku-4-5' }), { tokens: 150_000, window: 200_000, pct: 75 });
  assert.deepEqual(contextSummary({ tokens: 300_000, model: 'mystery' }), { tokens: 300_000, window: 200_000, pct: 100 }); // clamped
  assert.equal(contextSummary(null), null);
  assert.equal(contextSummary(undefined), null);
  assert.equal(contextSummary({ tokens: 0, model: 'claude-opus-5-5' }), null);
});

test('toolSummary totals all tools, sorts and caps byName, tolerates missing state', () => {
  const tools = { Bash: { count: 40, errors: 3 }, Read: { count: 90, errors: 0 }, Edit: { count: 40, errors: 1 }, '(unknown)': { count: 0, errors: 2 } };
  const s = toolSummary(tools, 2);
  assert.equal(s.total, 170);
  assert.equal(s.errors, 6);
  assert.deepEqual(s.byName, [{ name: 'Read', count: 90, errors: 0 }, { name: 'Bash', count: 40, errors: 3 }]);
  assert.equal(toolSummary(undefined), null);
  assert.equal(toolSummary({}), null);
});
