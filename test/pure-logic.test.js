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
