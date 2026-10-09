# Cost Everywhere (Batch A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place a session appears shows an honest, current, plan-aware cost estimate, including sessions that are still running, with a per-model breakdown in the transcript viewer and rate overrides that never go silently stale.

**Architecture:** `lib/pricing.js` becomes the single source of rates: a refreshed bundled table, Claude Code's `modelPricing` override shape (read from managed settings and from our own `config.json`), and an `assumed` flag for unpriced models. The collector loads that table once per `assemble()` and threads it through every cost call; live sessions gain `estCost` / `burnRate`; `/api/session` gains a `usage` breakdown built from the meta the collector already holds. The UI routes all cost labels through one `costWording()` helper keyed off the detected plan.

**Tech Stack:** Node ≥ 18, zero npm dependencies, `node:test` + `node:assert`, single-file UI in `public/index.html` (inline CSS + JS).

**Spec:** `docs/superpowers/specs/2026-10-08-cost-toolset-context-design.md` (section A, A0 through A5). Batches B and C have their own plans.

## Global Constraints

- Never write to anything under `~/.claude`, to `~/.claude.json`, or to any project's `.claude/` directory. Reads only.
- No new network calls. The managed settings file and `config.json` are local reads.
- Zero npm dependencies. `package.json` must not gain a dependency.
- Anything added to the polled `state` object must be rounded or integer so the SSE fingerprint only changes when a displayed digit would (cents for dollars, whole numbers for percentages).
- Transcript scanning stays head + tail + incremental. No task here parses a whole `.jsonl`.
- New logic in `lib/` is a pure, exported function with a test in `test/pure-logic.test.js` wherever it can be.
- Every cost figure is an estimate. Wording: `estimated cost` when `plan.billing === 'api'`, `list-price value` otherwise. The `≈` prefix stays in both cases.
- Rate table is cached as of 2026-10-06; the file comment carries that date.
- Commit after each task. Run `npm test` before every commit.

## Review Focus

1. A model id with a provider prefix or dated suffix (`us.anthropic.claude-sonnet-4-6-v1:0`, `claude-sonnet-4-6-20260101`) must still hit the override row keyed by the bare built-in id, and must still hit the bundled prefix row when there is no override. (Task 2 tests `overrideFor` with both shapes.)
2. A malformed `modelPricing` (string multiplier, negative rate, missing `cacheWrite`, `overrides` not an object) must never throw and must never zero every cost; bad rows drop one by one. (Task 2 tests each shape.)
3. A live session whose transcript has not been scanned yet, or has no assistant turn, must show no cost rather than `$NaN` or `$0.00/h`. (Task 4 tests `burnRate(null, …)` and `burnRate(0, …)`; Task 5 guards `usageBySession.get()` returning undefined.)
4. A session with output tokens but zero input of any kind must give `cacheHitRatio` of `null`, not `NaN`, and the UI must omit the cache figure. (Task 4 tests the zero-denominator case.)
5. A session under five minutes old must show no burn rate, so a one-turn session never reads as hundreds of dollars an hour. (Task 4 tests 4m59s → `null`, 5m → number.)

---

### Task 1: Refresh the bundled rate table

**Files:**
- Modify: `lib/pricing.js:1-37`
- Test: `test/pure-logic.test.js:124-153`

**Interfaces:**
- Consumes: nothing new.
- Produces: `rateFor(model) -> { input, output, cacheRead, cacheWrite, assumed }`, all USD per million tokens, `cacheRead` and `cacheWrite` now absolute; `normalizeModel(model) -> string` mapping bare aliases; `estimateCost(usageByModel) -> number` unchanged in signature.

- [ ] **Step 1: Update the existing pricing tests to the new rates**

Replace the three tests between `const { estimateCost, rateFor } = require('../lib/pricing');` and the `const { matchesPrefix }` line with:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^(not ok|ok)" | head -40`
Expected: `not ok` for the four pricing tests (`normalizeModel is not a function`, `cacheRead` undefined, 73.5 ≠ 72.75, 16 ≠ 11). The `dailyCostSeries` test still passes (opus-5 stays $5).

- [ ] **Step 3: Replace the top of `lib/pricing.js`**

Replace everything from the first line through the end of `estimateCost` (the current lines 1-39) with:

```js
'use strict';
// Estimated cost from token usage at Anthropic list rates (USD per MTok).
// Cache write = 1.25x input. Cache read = 0.1x input unless the row sets
// `cacheRead` (Fable and Opus 5.5 price cache reads below the usual tenth).
// List-price estimates: on a subscription they show relative weight, not
// billed dollars. Rates cached 2026-10-06; matched by id prefix, most
// specific first. Haiku 5.5's >100K-prompt tier ($0.50 / $2.50) is ignored.
const RATES = [
  { prefix: 'claude-fable-5', input: 10, output: 50, cacheRead: 0.25 }, // 5 and 5-1
  { prefix: 'claude-mythos', input: 10, output: 50, cacheRead: 0.25 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
  { prefix: 'claude-opus-4-1', input: 15, output: 75 },
  { prefix: 'claude-opus-4-0', input: 15, output: 75 },
  { prefix: 'claude-opus-4-2025', input: 15, output: 75 },
  { prefix: 'claude-opus', input: 5, output: 25 }, // 4-5 … 4-8
  { prefix: 'claude-sonnet-5', input: 2, output: 10 }, // 5 and 5-5
  { prefix: 'claude-sonnet', input: 3, output: 15 }, // 4-6 and older
  { prefix: 'claude-haiku-5', input: 0.1, output: 0.5 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4 },
  { prefix: 'claude-haiku', input: 1, output: 5 },
];
const DEFAULT_RATE = { input: 5, output: 25 }; // unknown model: assume opus-tier

// Bare family aliases that some transcript records carry instead of an id.
const ALIASES = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

function normalizeModel(model) {
  const m = String(model || '');
  return ALIASES[m] || m;
}

function expandRate(r, assumed) {
  return {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead !== undefined ? r.cacheRead : r.input * 0.1,
    cacheWrite: r.input * 1.25,
    assumed,
  };
}

// -> { input, output, cacheRead, cacheWrite, assumed }, USD per MTok.
// `assumed` is true when the id matched nothing and the opus-tier
// fallback is in use — the UI flags those so a stale table is visible.
function rateFor(model) {
  const m = normalizeModel(model);
  for (const r of RATES) if (m.startsWith(r.prefix)) return expandRate(r, false);
  return expandRate(DEFAULT_RATE, true);
}

// usageByModel: { [model]: {input, output, cacheRead, cacheCreation} } (token counts)
function estimateCost(usageByModel) {
  let usd = 0;
  for (const [model, u] of Object.entries(usageByModel || {})) {
    const r = rateFor(model);
    usd +=
      ((u.input || 0) * r.input +
        (u.output || 0) * r.output +
        (u.cacheRead || 0) * r.cacheRead +
        (u.cacheCreation || 0) * r.cacheWrite) /
      1_000_000;
  }
  return usd;
}
```

Then change the `module.exports` line at the bottom to:

```js
module.exports = { estimateCost, totalTokens, rateFor, normalizeModel, budgetLevel, typicalWait };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all `ok`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.js test/pure-logic.test.js
git commit -m "Pricing: refresh rate table to 2026-10-06 list prices, per-row cache-read, bare aliases

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `modelPricing` overrides and the unpriced-model report

**Files:**
- Modify: `lib/pricing.js` (after Task 1)
- Test: `test/pure-logic.test.js` (append after the Task 1 tests)

**Interfaces:**
- Consumes: `rateFor`, `normalizeModel`, `RATES` from Task 1.
- Produces:
  - `loadPricing(managedRaw, configRaw) -> { multiplier: number, overrides: { [id]: { input, output, cacheRead, cacheWrite } }, source: 'managed' | 'config' | null }`
  - `overrideFor(model, pricing) -> row | null`
  - `rateFor(model, pricing = null)` (second optional parameter added)
  - `costReport(usageByModel, pricing = null) -> { usd: number, assumedModels: string[] }`
  - `estimateCost(usageByModel, pricing = null)` (second optional parameter added)

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js` directly after the Task 1 `estimateCost sums across models` test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok" | head`
Expected: five `not ok` lines, first failure `loadPricing is not a function`.

- [ ] **Step 3: Implement overrides in `lib/pricing.js`**

Replace the `rateFor` and `estimateCost` functions from Task 1 with the block below (keep `RATES`, `DEFAULT_RATE`, `ALIASES`, `normalizeModel`, `expandRate` as they are):

```js
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Contracted or self-supplied rates in the shape of Claude Code's managed
// `modelPricing` setting: { multiplier, overrides: { [modelId]: { input,
// output, cacheRead, cacheWrite } } }, USD per MTok. The higher-precedence
// source (managed settings, then our config.json) wins whole. Validation
// mirrors Claude Code: a bad multiplier is ignored, a bad row is dropped
// and the rest kept, nothing throws.
function loadPricing(managedRaw, configRaw) {
  const pick = (raw, source) => {
    if (!raw || typeof raw !== 'object') return null;
    const table = { multiplier: 1, overrides: {}, source };
    if (typeof raw.multiplier === 'number' && raw.multiplier > 0 && raw.multiplier <= 10) {
      table.multiplier = raw.multiplier;
    }
    const overrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
    for (const [id, row] of Object.entries(overrides)) {
      if (!row || typeof row !== 'object') continue;
      const ok = RATE_KEYS.every((k) => typeof row[k] === 'number' && row[k] >= 0 && row[k] <= 10000);
      if (ok) table.overrides[id] = { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite };
    }
    return table;
  };
  return pick(managedRaw, 'managed') || pick(configRaw, 'config') || { multiplier: 1, overrides: {}, source: null };
}

// Provider-specific ids (us.anthropic.claude-x-v1:0, claude-x@20260101)
// reduce to the built-in id so a row keyed by that id covers them.
function baseModelId(model) {
  return normalizeModel(model)
    .replace(/^([a-z]+\.)*anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@.*$/, '');
}

// Exact key first; then the bare built-in id; then a built-in id row
// covers its dated snapshots. Keys that aren't built-in ids match exactly.
function overrideFor(model, pricing) {
  if (!pricing || !pricing.overrides) return null;
  const m = normalizeModel(model);
  if (pricing.overrides[m]) return pricing.overrides[m];
  const base = baseModelId(m);
  if (pricing.overrides[base]) return pricing.overrides[base];
  for (const [key, row] of Object.entries(pricing.overrides)) {
    if (key.startsWith('claude-') && base.startsWith(key + '-20')) return row;
  }
  return null;
}

// -> { input, output, cacheRead, cacheWrite, assumed }, USD per MTok.
// `assumed` is true when the id matched nothing and the opus-tier
// fallback is in use — the UI flags those so a stale table is visible.
function rateFor(model, pricing = null) {
  const o = overrideFor(model, pricing);
  let base;
  if (o) base = { ...o, assumed: false };
  else {
    const m = normalizeModel(model);
    const row = RATES.find((r) => m.startsWith(r.prefix));
    base = row ? expandRate(row, false) : expandRate(DEFAULT_RATE, true);
  }
  const mult = pricing && pricing.multiplier ? pricing.multiplier : 1;
  return {
    input: base.input * mult,
    output: base.output * mult,
    cacheRead: base.cacheRead * mult,
    cacheWrite: base.cacheWrite * mult,
    assumed: base.assumed,
  };
}

// usageByModel: { [model]: {input, output, cacheRead, cacheCreation} } (token counts)
// -> { usd, assumedModels } where assumedModels lists ids priced at the fallback.
function costReport(usageByModel, pricing = null) {
  let usd = 0;
  const assumed = new Set();
  for (const [model, u] of Object.entries(usageByModel || {})) {
    const r = rateFor(model, pricing);
    if (r.assumed) assumed.add(model);
    usd +=
      ((u.input || 0) * r.input +
        (u.output || 0) * r.output +
        (u.cacheRead || 0) * r.cacheRead +
        (u.cacheCreation || 0) * r.cacheWrite) /
      1_000_000;
  }
  return { usd, assumedModels: [...assumed].sort() };
}

function estimateCost(usageByModel, pricing = null) {
  return costReport(usageByModel, pricing).usd;
}
```

Update the export line:

```js
module.exports = { estimateCost, costReport, totalTokens, rateFor, normalizeModel, loadPricing, overrideFor, budgetLevel, typicalWait };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.js test/pure-logic.test.js
git commit -m "Pricing: modelPricing overrides (managed or config.json), costReport with unpriced-model list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire the pricing source through config, collector, and `/api/config`

**Files:**
- Modify: `lib/paths.js:39`
- Modify: `lib/config.js:7,49-60,236-259`
- Modify: `lib/collector.js:16-17,230-275,393-410,437-456,495-553`
- Modify: `server.js:127-129,269-283`
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Consumes: `loadPricing`, `costReport`, `estimateCost(usage, pricing)` from Task 2.
- Produces:
  - `managedSettingsPath(platform = process.platform) -> string` in `lib/paths.js`
  - `readPricing() -> pricing table` in `lib/config.js`
  - `collector.unpricedModels() -> string[]`
  - `GET /api/config` gains `pricingSource: 'managed' | 'config' | null` and `unpricedModels: string[]`
  - Every `estimateCost` call in the collector receives the loaded table.

- [ ] **Step 1: Confirm the managed settings paths against the docs**

Run:
```bash
curl -s https://code.claude.com/docs/en/managed-settings | grep -oE '[A-Za-z:/\\ ]*managed-settings\.json' | sort -u
```
Expected: lines containing `/Library/Application Support/ClaudeCode/managed-settings.json`, `/etc/claude-code/managed-settings.json`, and `C:\Program Files\ClaudeCode\managed-settings.json` (the Windows one may print with escaped backslashes). If a path differs from what Step 3 writes, use the docs' value. If the fetch fails (offline), proceed with the values in Step 3; a wrong path only means no managed file is found, which is the common case anyway.

- [ ] **Step 2: Write the failing test**

Append to `test/pure-logic.test.js`:

```js
// --- managed settings location ---
const { managedSettingsPath } = require('../lib/paths');

test('managedSettingsPath is per platform and never under the home dir', () => {
  assert.equal(managedSettingsPath('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.equal(managedSettingsPath('linux'), '/etc/claude-code/managed-settings.json');
  assert.equal(managedSettingsPath('win32'), 'C:/Program Files/ClaudeCode/managed-settings.json');
  assert.ok(!managedSettingsPath('darwin').includes('.claude'));
});
```

Run: `npm test 2>&1 | grep -E "^not ok"`
Expected: `not ok … managedSettingsPath is not a function`.

- [ ] **Step 3: Add the path helper**

In `lib/paths.js`, before `module.exports`:

```js
// Claude Code's admin-deployed managed settings file (read-only to us).
// Forward slashes on Windows too; Node's fs accepts them.
function managedSettingsPath(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:/Program Files/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}
```

And export it: `module.exports = { CLAUDE_DIR, canonicalize, worktreeRoot, encodeProjectDir, managedSettingsPath };`

Run: `npm test 2>&1 | tail -3` → `# fail 0`.

- [ ] **Step 4: Add `readPricing()` to `lib/config.js`**

Change line 7 to:

```js
const { canonicalize, managedSettingsPath } = require('./paths');
const { loadPricing } = require('./pricing');
```

After `readConfig()` (around line 60), add:

```js
// Rate table: Claude Code's managed `modelPricing` first (contracted rates
// an admin deployed), then the same key in our config.json, then bundled
// list prices. Both files are small; read fresh every call like readConfig.
function readPricing() {
  const managed = readJson(managedSettingsPath(), null);
  return loadPricing(managed && managed.modelPricing, readConfig().modelPricing);
}
```

Add `readPricing,` to `module.exports` (after `readConfig,`).

- [ ] **Step 5: Thread the table through the collector**

In `lib/collector.js`:

Line 16-17 become:
```js
const { readConfig, readPricing } = require('./config');
const { estimateCost, costReport, budgetLevel, typicalWait } = require('./pricing');
```

In `assemble()`, right after `const cfg = readConfig(); // read once, not per session` add:
```js
    const pricing = readPricing(); // one table per assemble, threaded into every cost
```

Then change every `estimateCost(` call inside `assemble()` to pass `pricing` as the second argument. There are three: the `spend7d` reduce (`estimateCost(combinedUsage(m), pricing)`), the session row `estCost` (`estimateCost(combinedUsage(m), pricing)`), and the `weeklyCost[idx] += estimateCost(combinedUsage(m), pricing)` bucket.

In the session row object (the `sessions: sessionMetas.slice(...)` map), replace the `estCost` line with:
```js
            estCost: estimateCost(combinedUsage(m), pricing),
            assumed: costReport(combinedUsage(m), pricing).assumedModels.length > 0,
```

In `allSessions()`, add `const pricing = readPricing();` after the `notes` line and pass it: `estCost: estimateCost(combinedUsage(m), pricing),`.

In `statsSummary()`, add `const pricing = readPricing();` as the first line of the function body and pass it to both `estimateCost` calls (`mWeekCost += estimateCost(byM, pricing)` and `const cost = estimateCost({ [model]: u }, pricing)`).

Add a new method after `allSessions()`:
```js
  // Distinct model ids that fell through to the fallback rate, for the
  // settings diagnostics: a non-empty list means the rate table is stale.
  unpricedModels() {
    const pricing = readPricing();
    const out = new Set();
    for (const m of this.raw.metaBySession.values()) {
      for (const id of costReport(combinedUsage(m), pricing).assumedModels) out.add(id);
    }
    return [...out].sort();
  }
```

- [ ] **Step 6: Expose the source and the unpriced list on `/api/config`**

In `server.js`, in the real `/api/config` GET handler (line ~269), add two fields after `ignores: cfg.readIgnores(),`:
```js
      pricingSource: cfg.readPricing().source,
      unpricedModels: collector.unpricedModels(),
```

In the demo branch (line ~128) add `pricingSource: null, unpricedModels: []` to the returned object, after `errors: []`.

- [ ] **Step 7: Verify end to end**

Run:
```bash
npm test 2>&1 | tail -3
CLAUDE_DASH_PORT=4599 node server.js & sleep 2
curl -s http://127.0.0.1:4599/api/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log("source:",c.pricingSource,"unpriced:",c.unpricedModels)})'
kill %1
```
Expected: `# fail 0`; then `source: null unpriced: [...]` (the list may be empty or hold ids your transcripts use that the table doesn't know; either is fine here).

Then prove the config override is honoured without touching `~/.claude`: temporarily add to `config.json` (repo root, gitignored) `"modelPricing": { "multiplier": 2 }`, restart on 4599, and confirm `source: config` and that the header 7-day figure in `http://127.0.0.1:4599` doubled. Remove the key afterwards.

- [ ] **Step 8: Commit**

```bash
git add lib/paths.js lib/config.js lib/collector.js server.js test/pure-logic.test.js
git commit -m "Pricing source: managed modelPricing, config.json override, unpriced models on /api/config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `burnRate`, `cacheHitRatio`, `topByCost` helpers

**Files:**
- Modify: `lib/pricing.js`
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces:
  - `burnRate(usd, startedAt, now = Date.now()) -> number | null` (USD per hour, cents; null under 5 minutes or with no cost)
  - `cacheHitRatio(usageByModel) -> number | null` (0..1; null when no input of any kind)
  - `topByCost(items, n = 10) -> items[]` (items have `.cost`; sorted desc, under one cent dropped)

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
// --- burn rate, cache hit ratio, top-N ---
const { burnRate, cacheHitRatio, topByCost } = require('../lib/pricing');

test('burnRate is null until five minutes in, then dollars per hour to the cent', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(burnRate(1, t0, t0 + 4 * 60000 + 59000), null);
  assert.equal(burnRate(1, t0, t0 + 5 * 60000), 12);         // $1 in 5 min = $12/h
  assert.equal(burnRate(1, t0, t0 + 30 * 60000), 2);         // $1 in 30 min
  assert.equal(burnRate(0.123, t0, t0 + 60 * 60000), 0.12);  // rounded to cents
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok"`
Expected: three `not ok`, first `burnRate is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/pricing.js` before `module.exports`:

```js
// Dollars per hour for a running session. Null for the first five minutes:
// one turn in a fresh session would otherwise read as hundreds per hour.
const BURN_MIN_MS = 5 * 60 * 1000;
function burnRate(usd, startedAt, now = Date.now()) {
  if (!usd || !startedAt) return null;
  const ms = now - startedAt;
  if (ms < BURN_MIN_MS) return null;
  return Math.round((usd / (ms / 3600000)) * 100) / 100;
}

// Share of input-side tokens served from the prompt cache, 0..1.
// Null when the session has no input-side tokens at all.
function cacheHitRatio(usageByModel) {
  let read = 0;
  let all = 0;
  for (const u of Object.values(usageByModel || {})) {
    read += u.cacheRead || 0;
    all += (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
  }
  return all ? read / all : null;
}

// Top n by `.cost`, descending; entries under a cent are noise.
function topByCost(items, n = 10) {
  return [...items].filter((i) => i.cost >= 0.01).sort((a, b) => b.cost - a.cost).slice(0, n);
}
```

Export them: add `burnRate, cacheHitRatio, topByCost` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -3` → `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.js test/pure-logic.test.js
git commit -m "Pricing: burnRate, cacheHitRatio, topByCost helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Cost and burn rate on live sessions (state + demo)

**Files:**
- Modify: `lib/collector.js:17,296-305,344-368`
- Modify: `lib/demo.js:69-105`

**Interfaces:**
- Consumes: `costReport`, `burnRate` (Tasks 2, 4); `combinedUsage` from `lib/transcripts.js`.
- Produces: each entry of `state.liveSessions[]` gains `estCost: number | null` (cents), `burnRate: number | null` (USD/h, cents), `assumed: boolean`.

- [ ] **Step 1: Build `usageBySession` next to `modelBySession`**

In `lib/collector.js`, change the pricing import to include `burnRate`:
```js
const { estimateCost, costReport, budgetLevel, typicalWait, burnRate } = require('./pricing');
```

In `assemble()`, where `titleBySession`, `modelBySession`, `subsBySession` are declared (around line 296), add:
```js
    const usageBySession = new Map();
```
and inside the loop that fills them, after `if (m.model) modelBySession.set(m.sessionId, m.model);`, add:
```js
        usageBySession.set(m.sessionId, combinedUsage(m));
```

- [ ] **Step 2: Add the fields to each live session**

In the `liveSessions = this.raw.live.map((s) => { ... })` callback, just before the `return {` statement, add:
```js
      // Rounded before entering state so the fingerprint only moves when a
      // displayed digit would. Null until the transcript has been scanned.
      const report = costReport(usageBySession.get(s.sessionId) || {}, pricing);
      const estCost = report.usd >= 0.005 ? Math.round(report.usd * 100) / 100 : null;
```
and in the returned object, after `model: modelBySession.get(s.sessionId) || null,`, add:
```js
        estCost,
        burnRate: burnRate(estCost, s.startedAt),
        assumed: report.assumedModels.length > 0,
```

- [ ] **Step 3: Demo data**

In `lib/demo.js` `liveSessions`, add to the S1 object after `model: 'claude-opus-5',`:
```js
        estCost: 24.6, burnRate: 11.3, assumed: false,
```
to S2 after `model: 'claude-fable-5',`:
```js
        estCost: 61.2, burnRate: 19.1, assumed: false,
```
to S4 after `model: 'claude-sonnet-5',`:
```js
        estCost: 3.4, burnRate: 9.3, assumed: false,
```

- [ ] **Step 4: Verify**

Run:
```bash
npm test 2>&1 | tail -3
CLAUDE_DASH_PORT=4599 node server.js & sleep 3
curl -sN http://127.0.0.1:4599/api/events | head -c 200000 | grep -o '"estCost":[^,]*,"burnRate":[^,]*,"assumed":[a-z]*' | head -5
kill %1
```
Expected: `# fail 0`; one line per live session (this session included) such as `"estCost":12.34,"burnRate":3.21,"assumed":false`. A session started under five minutes ago shows `"burnRate":null`. If no `claude` session is running, start one in another terminal first.

- [ ] **Step 5: Commit**

```bash
git add lib/collector.js lib/demo.js
git commit -m "Live sessions carry estCost, burnRate, and the unpriced flag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `usageBreakdown` and the `/api/session` usage block

**Files:**
- Modify: `lib/transcripts.js:1-20,476-500,565-569`
- Modify: `lib/collector.js:10,582-592`
- Modify: `server.js:383-407`
- Modify: `lib/demo.js` (`demoSession`)
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Consumes: `costReport`, `estimateCost`, `cacheHitRatio`, `totalTokens` (pricing); `combinedUsage`, `subagentSummary` (transcripts).
- Produces:
  - `usageBreakdown(meta, pricing = null) -> null | { cost, tokens, cacheHitRatio, byModel: [{ model, input, output, cacheRead, cacheCreation, cost }], subagents: { count, cost, tokens } | null, assumedModels: string[], context: null, tools: null }`
  - `collector.findSessionFile(id)` returns an extra `usage` field.
  - `GET /api/session?id=` (with `after` absent or 0) returns `usage`; with `after > 0` it is omitted.
  - `context` and `tools` are `null` here; the batch C plan fills them from `meta.context` / `meta.tools`.

- [ ] **Step 1: Write the failing test**

Append to `test/pure-logic.test.js`:

```js
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
});

test('usageBreakdown is null for a session with no usage and has no subagents block without them', () => {
  assert.equal(usageBreakdown({ usage: {} }), null);
  assert.equal(usageBreakdown({}), null);
  const u = usageBreakdown({ usage: { 'claude-sonnet-5-5': { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 } } });
  assert.equal(u.subagents, null);
  assert.equal(u.cost, 0);           // $0.002 rounds to 0.00 — the UI shows "$0.00"
  assert.equal(u.cacheHitRatio, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -E "^not ok"`
Expected: `usageBreakdown is not a function`.

- [ ] **Step 3: Implement in `lib/transcripts.js`**

Find the existing pricing import near the top of the file (it imports `estimateCost` and `totalTokens`; run `grep -n "require('./pricing')" lib/transcripts.js`) and change it to:
```js
const { estimateCost, costReport, totalTokens, cacheHitRatio } = require('./pricing');
```

After `subagentSummary` (around line 483) add:

```js
// Cost breakdown for the transcript viewer, from the meta the collector
// already holds — never re-reads the file. `context` and `tools` are
// filled by the scanner once the context-pressure batch lands.
function usageBreakdown(meta, pricing = null) {
  const combined = combinedUsage(meta || {});
  if (!Object.keys(combined).length) return null;
  const cents = (n) => Math.round(n * 100) / 100;
  const byModel = Object.entries(combined)
    .map(([model, u]) => ({
      model,
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheCreation: u.cacheCreation || 0,
      cost: cents(estimateCost({ [model]: u }, pricing)),
    }))
    .sort((a, b) => b.cost - a.cost);
  const report = costReport(combined, pricing);
  const subs = subagentSummary(meta);
  return {
    cost: cents(report.usd),
    tokens: totalTokens(combined),
    cacheHitRatio: cacheHitRatio(combined),
    byModel,
    subagents: subs
      ? { count: subs.count, cost: cents(estimateCost(meta.subagentUsage, pricing)), tokens: totalTokens(meta.subagentUsage) }
      : null,
    assumedModels: report.assumedModels,
    context: meta.context || null,
    tools: meta.tools || null,
  };
}
```

Add `usageBreakdown` to `module.exports`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | tail -3` → `# fail 0`.

- [ ] **Step 5: Return it from the collector and the endpoint**

In `lib/collector.js` line 10, add `usageBreakdown` to the list imported from `./transcripts`. In `findSessionFile`, change the returned object to include it (keep every existing field):
```js
          return {
            file: m.file,
            title: this.titleOf(m).title,
            projectName: friendlyName(g.path),
            note: (readConfig().sessionNotes || {})[m.sessionId] || null,
            agents: this.agentsFor(m, this.raw.live.some((s) => s.sessionId === sessionId)),
            usage: usageBreakdown(m, readPricing()),
          };
```

In `server.js` `/api/session` handler, in the `res.end(JSON.stringify({ ... }))` object, add after `agents: ...,`:
```js
          usage: after ? undefined : (found.usage || null),
```

- [ ] **Step 6: Demo session usage**

In `lib/demo.js`, rename the existing `function demoSession(id, after)` to `function demoSessionInner(id, after)` and add below it:

```js
const DEMO_USAGE = {
  cost: 61.2, tokens: 14_300_000, cacheHitRatio: 0.93,
  byModel: [
    { model: 'claude-fable-5', input: 210_000, output: 480_000, cacheRead: 11_900_000, cacheCreation: 640_000, cost: 55.9 },
    { model: 'claude-haiku-4-5', input: 120_000, output: 90_000, cacheRead: 860_000, cacheCreation: 0, cost: 5.3 },
  ],
  subagents: { count: 4, cost: 5.3, tokens: 1_070_000 },
  assumedModels: [], context: null, tools: null,
};

// The usage block rides only on the initial load, like the real endpoint.
function demoSession(id, after) {
  const t = demoSessionInner(id, after);
  return after ? t : { ...t, usage: DEMO_USAGE };
}
```

- [ ] **Step 7: Verify**

Run:
```bash
npm test 2>&1 | tail -3
CLAUDE_DASH_PORT=4599 node server.js & sleep 3
ID=$(ls -t ~/.claude/projects/*/*.jsonl | head -1 | xargs basename | sed 's/.jsonl//')
curl -s "http://127.0.0.1:4599/api/session?id=$ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(JSON.stringify(t.usage,null,1).slice(0,600))})'
curl -s "http://127.0.0.1:4599/api/session?id=$ID&after=1000" | grep -c '"usage"'
kill %1
```
Expected: the first prints a `usage` object with `byModel` rows and a `cost`; the second prints `0` (no usage on incremental loads).

- [ ] **Step 8: Commit**

```bash
git add lib/transcripts.js lib/collector.js server.js lib/demo.js test/pure-logic.test.js
git commit -m "Session endpoint: per-model usage breakdown with subagent share and cache ratio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `topSessions` and the weekly cache hit rate in `statsSummary`

**Files:**
- Modify: `lib/collector.js:495-580`
- Modify: `lib/demo.js:179-240`

**Interfaces:**
- Consumes: `topByCost` (Task 4), `pricing` (Task 3).
- Produces: `statsSummary()` returns `topSessions: [{ sessionId, title, projectName, projectPath, model, cost, lastActivityAt }]` (max 10, cost desc) and `week.cacheHitRatio: number | null` (two decimals).

- [ ] **Step 1: Accumulate candidates and weekly cache counters**

In `lib/collector.js`, add `topByCost` to the pricing import.

In `statsSummary()`, next to `const weekWaits = [0, 0, 0, 0];` add:
```js
    const topCandidates = [];
    let weekCacheRead = 0;
    let weekCacheAll = 0;
```

Inside the week branch, in the loop `for (const [day, byM] of Object.entries(mDays)) { if (day >= weekDayKey) { ... } }`, add inside the `if`:
```js
              for (const u of Object.values(byM)) {
                weekCacheRead += u.cacheRead || 0;
                weekCacheAll += (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
              }
```

Replace the per-model loop `for (const [model, u] of Object.entries(combinedUsage(m))) { ... }` with a version that also sums the session's cost:
```js
        let mCost = 0;
        for (const [model, u] of Object.entries(combinedUsage(m))) {
          const e = byModel[model] || (byModel[model] = { tokens: 0, cost: 0 });
          const cost = estimateCost({ [model]: u }, pricing);
          e.tokens += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
          e.cost += cost;
          mCost += cost;
          projModels[model] = (projModels[model] || 0) + cost;
        }
        topCandidates.push({
          sessionId: m.sessionId,
          title: this.titleOf(m).title,
          projectName: friendlyName(g.path),
          projectPath: g.path,
          model: m.model || null,
          cost: Math.round(mCost * 100) / 100,
          lastActivityAt: m.lastActivityAt,
        });
```

In the returned object add, inside `week: { ... }` after `typicalWait: typicalWait(weekWaits),`:
```js
        cacheHitRatio: weekCacheAll ? Math.round((weekCacheRead / weekCacheAll) * 100) / 100 : null,
```
and at the top level after `perProject: perProject.slice(0, 15),`:
```js
      topSessions: topByCost(topCandidates, 10),
```

- [ ] **Step 2: Demo stats**

In `lib/demo.js` `demoStats()`, add to `week` after `waits: [22, 31, 18, 4], typicalWait: 'under 2m',`:
```js
      cacheHitRatio: 0.91,
```
and after the `perProject: [...]` array:
```js
    topSessions: [
      { sessionId: S2, title: 'Migrate posts to the new block format', projectName: 'Blog Engine', projectPath: '/demo/blog-engine', model: 'claude-fable-5', cost: 61.2, lastActivityAt: now - MIN },
      { sessionId: S1, title: 'Wire Stripe checkout into the cart', projectName: 'Acme Storefront', projectPath: '/demo/acme-storefront', model: 'claude-opus-5', cost: 24.6, lastActivityAt: now - 2 * MIN },
      { sessionId: S3, title: 'Design the onboarding flow', projectName: 'Acme Storefront', projectPath: '/demo/acme-storefront', model: 'claude-opus-5', cost: 18.9, lastActivityAt: now - 3 * HOUR },
    ],
```

- [ ] **Step 3: Verify**

Run:
```bash
npm test 2>&1 | tail -3
CLAUDE_DASH_PORT=4599 node server.js & sleep 3
curl -s http://127.0.0.1:4599/api/stats | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log("cache",t.week.cacheHitRatio);for(const x of t.topSessions)console.log(x.cost,x.projectName,"—",x.title.slice(0,50))})'
kill %1
```
Expected: `cache 0.xx` and up to ten rows in descending cost.

- [ ] **Step 4: Commit**

```bash
git add lib/collector.js lib/demo.js
git commit -m "Stats: top ten sessions by cost, weekly cache hit rate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: UI — `costWording()`, one chip helper, every tooltip, the unpriced marker

**Files:**
- Modify: `public/index.html` (CSS near line 292; JS near 1008, 1107, 1197, 1253, 1471, 2484)

**Interfaces:**
- Consumes: `state.plan.billing` (already in state), `assumed` on session rows (Task 3/5).
- Produces (client-side):
  - `costWording() -> { noun, tip }`
  - `costChip(usd, { cls = 's-when', assumed = false, before = '', after = '' } = {}) -> html string` (empty string when `fmtCost` returns empty)

- [ ] **Step 1: Confirm `lastState` is set before the header renders**

Run: `grep -n "lastState = \|^function render(" public/index.html`
Expected: `lastState` is assigned in the SSE handler (`lastState = JSON.parse(e.data)` around line 1396) before `render(lastState)` is called from there. If `render` is called with a value that is not yet in `lastState`, change that call site to assign first. `costWording()` reads `lastState`.

- [ ] **Step 2: Add the helpers**

Directly after `function fmtCost(usd) { ... }` (line ~1008) add:

```js
// Every cost figure is a list-price estimate. On API billing that is an
// estimate of the invoice; on a subscription it is a relative weight.
function costWording() {
  const api = lastState?.plan?.billing === 'api';
  return api
    ? { noun: 'estimated cost', tip: 'Estimated from token counts at Anthropic list prices. Your invoice is the source of truth.' }
    : { noun: 'list-price value', tip: 'What these tokens would cost at API list price. On a subscription this is a relative weight, not a bill.' };
}

const UNPRICED_TIP = 'A model in this session is not in this version\'s rate table; Opus-tier rate assumed. Update the dashboard or set modelPricing in config.json.';

// One chip for every cost figure: same wording, same tooltip, same marker.
function costChip(usd, { cls = 's-when', assumed = false, before = '', after = '' } = {}) {
  const f = fmtCost(usd);
  if (!f) return '';
  const w = costWording();
  const tip = `${w.noun} — ${w.tip}${assumed ? ` ${UNPRICED_TIP}` : ''}`;
  return `<span class="${cls}" title="${esc(tip)}">${before}≈${f}${assumed ? '<span class="unpriced" title="' + esc(UNPRICED_TIP) + '">?</span>' : ''}${after}</span>`;
}
```

Add CSS after `.dep-elapsed.overdue { ... }` (line ~293):
```css
  .unpriced { color: var(--warn); font-weight: 700; margin-left: 2px; cursor: help; }
```

- [ ] **Step 3: Route the existing five sites through it**

Line ~1107 (project card):
```js
      ${costChip(p.spend7d, { cls: 'badge', after: '/7d' })}
```
Line ~1197 (digest entry):
```js
      ${costChip(it.estCost, { cls: 'di-when', assumed: it.assumed })}
```
Line ~1253 (header spend chip): replace the `<span title="Estimated list-price value of all sessions in the last 7 days — relative weight, not billed dollars">7d ≈${fmtCost(spend)}</span>` part with:
```js
${costChip(spend, { cls: '', before: '7d ' })}
```
(keep the `weeklyChart(state.weeklyCost)` call in front of it, and the `fmtCost(spend) ? … : ''` guard around both).

Line ~1471 (project drawer session row):
```js
          ${costChip(s.estCost, { assumed: s.assumed })}
```
Line ~2484 (stats totals): replace `estimated list-price value, all time` with `${esc(costWording().noun)}, all time`.

Run: `grep -n "list-price" public/index.html`
Expected: only the two occurrences inside `costWording()`.

- [ ] **Step 4: Verify in the browser**

Run `CLAUDE_DASH_PORT=4599 node server.js &` and open `http://127.0.0.1:4599`. Hover the header 7d figure, a project card's `/7d` badge, and a session row's cost: each tooltip starts with `list-price value —` (or `estimated cost —` on an API-key login). Open a project drawer; a session using an unknown model shows an amber `?` after its cost. Then `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_PORT=4599 node server.js` and confirm the demo renders without console errors (`⌥⌘I` → Console). Stop the server.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "UI: plan-aware cost wording through one chip helper; unpriced-model marker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: UI — cost cell on the departures board and Mission Control panes

**Files:**
- Modify: `public/index.html` (CSS near line 292 and 604; `liveCard` ~1051-1083; `mcPaneHead` ~1870-1878)

**Interfaces:**
- Consumes: `liveSessions[].estCost`, `.burnRate`, `.assumed` (Task 5); `costChip` (Task 8).

- [ ] **Step 1: CSS**

After the `.unpriced` rule add:
```css
  .dep-cost { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15; min-width: 52px; }
  .dep-cost-main { color: var(--muted); font-size: 12px; }
  .dep-burn { color: var(--faint); font-size: 10.5px; }
```

- [ ] **Step 2: Departures row**

In `liveCard(s)`, inside `<div class="dep-right">`, directly after `${modelChip(s.model)}` add:
```js
      ${s.estCost != null ? `<span class="dep-cost">${costChip(s.estCost, { cls: 'dep-cost-main', assumed: s.assumed })}${
        s.burnRate ? `<span class="dep-burn" title="Estimated spend per hour at the current pace">$${s.burnRate.toFixed(2)}/h</span>` : ''}</span>` : ''}
```

- [ ] **Step 3: Mission Control pane head**

In `mcPaneHead(s)`, change `${modelChip(s.model)}${subs}` to:
```js
    ${modelChip(s.model)}${s.estCost != null ? costChip(s.estCost, { cls: 'mc-meta', assumed: s.assumed, after: s.burnRate ? ` · $${s.burnRate.toFixed(2)}/h` : '' }) : ''}${subs}
```

- [ ] **Step 4: Verify**

Run `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_PORT=4599 node server.js &`, open `http://127.0.0.1:4599`. Each departures row shows `≈$24.60` with `$11.30/h` beneath, right of the model chip. Press `▦` (Mission Control): each pane head shows `≈$24.60 · $11.30/h`. Then run without demo and confirm this live session shows a cost that ticks up as the transcript grows. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "UI: running cost and burn rate on the departures board and Mission Control

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: UI — cost badge and breakdown panel in the transcript viewer

**Files:**
- Modify: `public/index.html` (CSS near 745; `transcriptStatus` ~1591-1603; `openTranscript` ~1804-1812; `render` ~1236; click handler near the `data-note-toggle` handler)

**Interfaces:**
- Consumes: `/api/session` `usage` (Task 6), `liveSessions[].estCost` (Task 5), `costWording`/`costChip` (Task 8), `modelShort`, `esc`, `$`.
- Produces: `usagePanelHtml(u) -> html`, a `data-usage-toggle` button, a `#usage-panel` element.

- [ ] **Step 1: Keep the usage on the open session**

In `openTranscript`, after `exportableSession.changeCount = t.changeCount || 0;` add:
```js
    exportableSession.usage = t.usage || null;
```

- [ ] **Step 2: Badge in the header actions**

In `transcriptStatus()`, add as the first line inside the `$('#d-actions').innerHTML = \`` template, before the `changes` button:
```js
    ${exportableSession?.usage ? `<button class="copy" data-usage-toggle title="${esc(`${costWording().noun} — click for the breakdown by model`)}">≈${fmtCost(exportableSession.usage.cost) || '$0.00'}${exportableSession.usage.assumedModels?.length ? ' <span class="unpriced">?</span>' : ''} ▾</button>` : ''}
```

- [ ] **Step 3: The panel**

Add after `transcriptStatus()`:

```js
function fmtTok(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);
}

function usagePanelHtml(u) {
  const w = costWording();
  const rows = u.byModel.map((r) => `<tr>
    <td>${esc(modelShort(r.model))}${u.assumedModels?.includes(r.model) ? ' <span class="unpriced" title="' + esc(UNPRICED_TIP) + '">?</span>' : ''}</td>
    <td>${fmtTok(r.input)}</td><td>${fmtTok(r.output)}</td><td>${fmtTok(r.cacheRead)}</td><td>${fmtTok(r.cacheCreation)}</td>
    <td>≈$${r.cost.toFixed(2)}</td></tr>`).join('');
  const subs = u.subagents
    ? `<tr><td colspan="5">of which subagents (${u.subagents.count}, ${fmtTok(u.subagents.tokens)} tok)</td><td>≈$${u.subagents.cost.toFixed(2)}</td></tr>`
    : '';
  const foot = [
    u.cacheHitRatio != null ? `cache ${Math.round(u.cacheHitRatio * 100)}% of input served from cache` : null,
    u.context ? `context ${fmtTok(u.context.tokens)} / ${fmtTok(u.context.window)} (${u.context.pct}%)` : null,
    u.tools ? `${u.tools.total} tool calls${u.tools.errors ? `, ${u.tools.errors} failed` : ''}` : null,
    u.assumedModels?.length ? `unpriced: ${u.assumedModels.map(modelShort).join(', ')} (Opus-tier rate assumed)` : null,
  ].filter(Boolean).join(' · ');
  return `<div id="usage-panel">
    <table class="stat-table usage-table">
      <tr class="h"><td>model</td><td>in</td><td>out</td><td>cache read</td><td>cache write</td><td>${esc(w.noun)}</td></tr>
      ${rows}${subs}
    </table>
    <div class="usage-foot">${esc(foot)}<span class="set-sub">${esc(w.tip)}</span></div>
  </div>`;
}

function toggleUsagePanel() {
  const existing = $('#usage-panel');
  if (existing) { existing.remove(); return; }
  if (!exportableSession?.usage) return;
  $('#d-body').insertAdjacentHTML('afterbegin', usagePanelHtml(exportableSession.usage));
}
```

Wire the click: find the existing `document.addEventListener('click', …)` handler that checks `e.target.closest('[data-note-toggle]')` and add next to it:
```js
  if (e.target.closest('[data-usage-toggle]')) { toggleUsagePanel(); return; }
```

CSS after `.stat-table td:last-child, …` (line ~745):
```css
  #usage-panel { margin: 0 0 14px; padding: 10px 12px; background: var(--surface2); border: 1px solid var(--line); border-radius: 6px; }
  .usage-table td { text-align: right; }
  .usage-table td:first-child { text-align: left; }
  .usage-table tr.h td { color: var(--faint); font-size: 11px; border-bottom: 1px solid var(--line); }
  .usage-foot { margin-top: 8px; font-size: 11.5px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
```

- [ ] **Step 4: Live refresh of the badge**

In `render(state)`, right after `liveIds = new Set(...)` add:
```js
  // A transcript being followed live keeps its header cost in step with the board.
  if (follow.id && exportableSession?.id === follow.id && exportableSession.usage) {
    const live = (state.liveSessions || []).find((s) => s.sessionId === follow.id);
    if (live && live.estCost != null && live.estCost !== exportableSession.usage.cost) {
      exportableSession.usage.cost = live.estCost;
      transcriptStatus();
    }
  }
```
Check that `follow` and `exportableSession` are declared before `render` runs (`grep -n "^const follow\|^let follow\|^let exportableSession" public/index.html`); both are module-level `let`/`const`, so this works regardless of order as long as `render` is not called before the script finishes parsing. It is not: the first call comes from the SSE handler.

- [ ] **Step 5: Verify**

Demo mode on 4599: click the Blog Engine session title. The header shows `≈$61.20 ▾`; clicking it inserts the breakdown table at the top with two model rows, a subagent row, and a footer starting `cache 93%`. Clicking again removes it. Real mode: open this live session; the badge updates within a poll or two after you send a prompt. Open a finished session with no assistant turns (or a brand-new one): no badge, no error in the console.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Transcript viewer: cost badge with per-model breakdown panel, live-updating

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: UI — most expensive sessions in stats, cache hit rate in the week report

**Files:**
- Modify: `public/index.html` (stats render ~2460-2484; week report ~2670-2712)

**Interfaces:**
- Consumes: `stats.topSessions`, `stats.week.cacheHitRatio` (Task 7).

- [ ] **Step 1: Stats section**

In the stats render, after `const projRows = ...` block and before the `$('#d-body').innerHTML =` assignment, add:
```js
    const topRows = (s.topSessions || []).map((t) => `<tr>
      <td><span class="s-title" data-session="${esc(t.sessionId)}" title="Click to read the transcript">${esc(t.title)}</span>
        <span class="set-sub">${esc(t.projectName)}${t.model ? ` · ${esc(modelShort(t.model))}` : ''}</span></td>
      <td>${relTime(t.lastActivityAt)}</td>
      <td>≈$${t.cost.toFixed(2)}</td></tr>`).join('');
```
and insert a section after `dSection('By model — all time', …) +`:
```js
      dSection('Most expensive sessions', topRows ? `<table class="stat-table">${topRows}</table>` : null, 'No sessions costed yet.') +
```

Confirm the global click handler already opens transcripts for `.s-title[data-session]`: `grep -n "closest('\[data-session\]')\|closest(\"\[data-session\]\")\|data-session" public/index.html | head -5`. It does (session titles in the drawer use the same attribute); if the handler is scoped to a container the stats view is not in, extend its selector rather than adding a second handler.

- [ ] **Step 2: Week report**

In `openWeekReport`, add a row to `rows` after the `'Models'` row:
```js
      ['Cache hit rate', w.cacheHitRatio != null ? `${Math.round(w.cacheHitRatio * 100)}% of input tokens served from cache` : 'not enough data yet'],
```
The markdown export iterates `rows`, so it picks this up with no further change.

- [ ] **Step 3: Verify**

Demo mode on 4599: click the weekly bar chart in the header. The stats view has a "Most expensive sessions" section with three rows; clicking a title opens that transcript. `⌘K` → "Your week with Claude": the table has a `Cache hit rate` row reading `91% …`; "download as markdown" includes it.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Stats: most expensive sessions; week report: cache hit rate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Settings — pricing source, unpriced models, copy skeleton; docs

**Files:**
- Modify: `public/index.html` (settings render ~2190-2250; settings click wiring ~2272)
- Modify: `config.example.json`
- Modify: `README.md` ("What you're looking at" bullets ~105-148; "Settings" ~158-171; "Configuration" ~196)

**Interfaces:**
- Consumes: `/api/config` `pricingSource`, `unpricedModels` (Task 3); `toast(msg)` (exists at line ~1312).

- [ ] **Step 1: Settings row**

In the settings render, in the `general` block, after the "Plugins & MCP servers" row add:
```js
      <div class="set-row">
        <span class="set-label">Pricing<span class="set-sub">${esc(
          c.pricingSource === 'managed' ? "using your organization's managed modelPricing rates"
          : c.pricingSource === 'config' ? 'using modelPricing from config.json'
          : 'bundled list prices, cached 2026-10-06')}${(c.unpricedModels || []).length
            ? ` · <span class="unpriced">?</span> unpriced: ${esc(c.unpricedModels.join(', '))} — Opus-tier rate assumed; update the dashboard or add modelPricing to config.json`
            : ''}</span></span>
        <button class="copy" id="set-pricing-copy" title="Copy a modelPricing block to paste into config.json">copy skeleton</button>
      </div>`;
```
(Keep the `esc()` around the source text only; the unpriced markup is built from server-provided ids that are already escaped individually.)

Next to the other settings listeners (where `$('#set-usage').addEventListener(...)` is, ~line 2272) add:
```js
    $('#set-pricing-copy').addEventListener('click', async () => {
      const skeleton = {
        modelPricing: {
          _note: 'USD per million tokens. multiplier scales every cost (0 < x <= 10); overrides are per model id with all four rates.',
          multiplier: 1,
          overrides: { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
        },
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(skeleton, null, 2));
        toast('modelPricing skeleton copied — merge it into config.json');
      } catch {
        toast('Clipboard blocked — see config.example.json for the shape');
      }
    });
```

- [ ] **Step 2: Example config**

Replace `config.example.json` with:
```json
{
  "terminal": "ghostty",
  "notifications": true,
  "modelPricing": {
    "multiplier": 1,
    "overrides": {
      "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 }
    }
  }
}
```

- [ ] **Step 3: README**

In "What you're looking at", replace the **Cost estimates** bullet with:
```
- **Cost estimates** — every session, project, and live row carries a `≈$` figure computed from the token counts in its transcript. On an API-key login it is labelled *estimated cost*; on a subscription it is *list-price value*, a relative weight rather than a bill (hover any figure for the wording). Rates are Anthropic list prices bundled with the dashboard (cached 2026-10-06). If your organization deploys Claude Code's `modelPricing` managed setting, the dashboard reads it and reports at your contracted rates; you can also put the same `modelPricing` block in `config.json` (⚙ settings → *copy skeleton*). A model the table doesn't know is priced at the Opus tier and marked with an amber `?` so a stale table is never silent. Subagent tokens are included.
- **Live cost** — running sessions show their cost so far on the departures board and in Mission Control, with a `$/h` burn rate once the session is five minutes old.
- **Session cost breakdown** — the `≈$ ▾` button in a transcript's header opens a table by model (input, output, cache read, cache write), the subagent share, and the session's cache hit rate.
- **Most expensive sessions** — in the stats view: the ten costliest sessions all time, click to open.
```
In "Settings", add a bullet:
```
- **Pricing** shows which rate table is active (bundled, `config.json`, or your organization's managed `modelPricing`) and lists any model the table doesn't price; *copy skeleton* puts a `modelPricing` block on the clipboard to paste into `config.json`
```
In "Your week with Claude", append `, and your cache hit rate` after `how long you typically take to answer a question`.

- [ ] **Step 4: Verify**

Real mode on 4599: ⚙ settings shows the Pricing row with `bundled list prices, cached 2026-10-06`; "copy skeleton" toasts and the clipboard holds valid JSON (`pbpaste | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("ok")'`). Paste it into `config.json`, restart on 4599: the row reads `using modelPricing from config.json`. Remove it afterwards.

- [ ] **Step 5: Commit**

```bash
git add public/index.html config.example.json README.md
git commit -m "Settings: pricing source and unpriced models; modelPricing skeleton; README for cost features

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Smoke test on real data and the installed service

**Files:** none modified unless a bug turns up.

- [ ] **Step 1: Full test run**

Run: `npm test 2>&1 | tail -5`
Expected: `# fail 0`.

- [ ] **Step 2: Cross-check one session three ways**

With the server on 4599 (not demo) and a `claude` session running:
1. Note the live row's `≈$` on the departures board.
2. Open its transcript: the header badge shows the same figure to the cent (they are the same `estCost`, rounded identically).
3. Open the breakdown panel: the `byModel` costs plus nothing else sum to the badge within one cent (per-row rounding).
4. Open the project drawer: the session row's `≈$` matches.
5. `curl -s http://127.0.0.1:4599/api/config` → `unpricedModels` is empty, or every id it lists shows a `?` somewhere you can find it.

- [ ] **Step 3: Fingerprint stability**

Run for 60 seconds with no session activity:
```bash
curl -sN http://127.0.0.1:4599/api/events | grep -c '^data:' & sleep 60; kill %1
```
Expected: a small number of state pushes (git/quota changes), not one every two seconds. If it pushes every poll, a float leaked into state unrounded; find it with `curl -sN … | head -c 400000 | grep -o '"burnRate":[0-9.]*\|"estCost":[0-9.]*' | sort -u`.

- [ ] **Step 4: Restart the installed service and glance at its log**

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-dashboard
sleep 3; tail -20 ~/Library/Logs/claude-dashboard.log
```
Expected: a clean start, no stack trace. Open `http://127.0.0.1:4517` and confirm costs render.

- [ ] **Step 5: Final commit if anything changed**

```bash
git status --short
# if files changed:
git add -A && git commit -m "Batch A smoke-test fixes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
