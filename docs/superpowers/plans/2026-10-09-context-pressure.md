# Context Pressure and Tool Activity (Batch C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every live session shows how full its context window is (a small meter, amber from 70%, red from 90%), and Mission Control and the transcript cost panel show how many tool calls the session made and how many failed.

**Architecture:** The incremental transcript scanner (`scanLine` in `lib/transcripts.js`) already parses every assistant record that carries usage; it additionally records the last message's prompt size and counts `tool_use` blocks by name, and a new branch attributes `is_error` tool results back to the tool by id. Pure summarisers turn that raw scan state into the rounded `{ tokens, window, pct }` and `{ total, errors, byName }` shapes; `contextWindow(model)` in `lib/pricing.js` supplies the window. The collector puts both on live sessions; `usageBreakdown` (batch A) puts them in `/api/session`'s `usage`, whose panel already renders them.

**Tech Stack:** Node ≥ 18, zero npm dependencies, `node:test` + `node:assert`, single-file UI in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-10-08-cost-toolset-context-design.md`, section C (C1 and C2). Batches A and B are on this branch.

## Global Constraints

- Transcript scanning stays head + tail + incremental: every addition lives in `scanLine`, which only ever sees bytes appended since the last scan. No task parses a whole `.jsonl`.
- Never write under `~/.claude`. No network calls. Zero npm dependencies.
- Anything added to polled state is rounded so the SSE fingerprint only changes when a displayed digit would: context `tokens` to the nearest 1,000, `pct` to a whole number; tool counts are integers that only change when the transcript grows.
- `contextWindow(model)`: 1,000,000 for ids matching `claude-fable-5`, `claude-mythos`, `claude-opus-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-5`, and the bare aliases `opus` / `sonnet` / `haiku`; 200,000 otherwise (Haiku 4.5, older models, unknown). Provider-form ids (`us.anthropic.…-v1:0`, `…@2026…`) resolve like their base id.
- Context is the main conversation only; subagent transcripts keep their own scan state and are not merged into it. Tool counts are main-loop only too.
- Meter colours: default below 70%, `--warn` from 70%, `--bad` from 90%.
- Every interpolated text value in new UI markup goes through `esc()`.
- New logic is pure and exported with tests in `test/pure-logic.test.js` wherever it can be. Commit after each task; `npm test` green before each commit; attribution trailer may name the model that wrote the commit.

## Review Focus

1. A transcript where one assistant message is written as several records with the same `message.id` (one per content block, each repeating the usage) must count each `tool_use` block once and must not double-count anything; the context figure comes from that message's usage once. (Task 2 tests three records sharing an id.)
2. A failed tool result whose `tool_use_id` is older than the 256-entry ring, or arrives before its `tool_use` (truncated head), counts under `"(unknown)"` and never throws. (Task 2 tests both.)
3. A session whose model is unknown or whose last assistant record has no usage shows no meter rather than `NaN%` or a 200K window on a 1M model. (Task 3 tests `contextSummary(null)` and an unknown model; Task 1 tests the provider-form ids.)
4. A context figure above the window (e.g. a model the table thinks is 200K but is really 1M) must clamp the bar at 100% and still show the true token count, not overflow the cell. (Task 3 tests `pct` capped at 100 while `tokens` keeps the real value.)
5. A server that was already running before this change has scan caches without `tools`; the summaries must treat missing state as zero / null, not throw. (Task 3 tests `toolSummary(undefined)`.)

---

### Task 1: `contextWindow(model)` in `lib/pricing.js`

**Files:**
- Modify: `lib/pricing.js` (add the function; export it)
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Consumes: `normalizeModel`, `baseModelId` (already in `lib/pricing.js`).
- Produces: `contextWindow(model) -> number` (1_000_000 or 200_000).

- [ ] **Step 1: Write the failing test**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern="contextWindow" test/pure-logic.test.js 2>&1 | grep -E "^not ok|is not a function"`
Expected: `contextWindow is not a function`.

- [ ] **Step 3: Implement**

In `lib/pricing.js`, before `module.exports`, add:

```js
// Context window per model, for the "how full is it" meter. Every Claude
// 5.x model and Opus/Sonnet 4.6+ is 1M; Haiku 4.5 and older are 200K.
// Unknown ids get 200K: an over-full meter on an unknown model is a
// visible prompt to update, a falsely empty one is not.
const MILLION_WINDOW = [
  'claude-fable-5', 'claude-mythos', 'claude-opus-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5',
];
function contextWindow(model) {
  const id = baseModelId(model);
  return MILLION_WINDOW.some((p) => id.startsWith(p)) ? 1_000_000 : 200_000;
}
```

(`baseModelId` already calls `normalizeModel`, which maps the bare aliases.) Add `contextWindow` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.js test/pure-logic.test.js
git commit -m "Pricing: contextWindow per model"
```

---

### Task 2: Scanner — last prompt size and tool counts

**Files:**
- Modify: `lib/transcripts.js` (`scanLine` ~185-260; `scanFile` meta copy ~150-157)
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces on the scan state (lazily created, so existing scan objects and caches keep working):
  - `scan.lastContext = { tokens, model, at }` — `tokens = input + cacheRead + cacheCreation` of the most recent assistant message (first record of each new `message.id`).
  - `scan.tools = { [name]: { count, errors } }`.
  - `scan.toolIds = [{ id, name }]` — ring of the last 256 `tool_use` ids, oldest first.
- Produces on the session meta: `meta.context = scan.lastContext || null`, `meta.tools = scan.tools || null`.
- Exported for tests: `TOOL_RING = 256`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js` (the helpers `freshScan` and `AUG10` already exist earlier in the file from the scanLine tests; do not redefine them):

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-name-pattern="scanLine records the prompt|scanLine counts tool_use|scanLine attributes|tool id ring|tool-result record" test/pure-logic.test.js 2>&1 | grep -E "^not ok" | head`
Expected: failures (`TOOL_RING` undefined, `scan.lastContext` undefined, `scan.tools` undefined).

- [ ] **Step 3: Implement in `scanLine`**

Add near the top of `lib/transcripts.js` (after the requires):

```js
// How many recent tool_use ids to remember for attributing failed results.
const TOOL_RING = 256;

function countToolUses(scan, content) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || !b.id) continue;
    const ring = scan.toolIds || (scan.toolIds = []);
    if (ring.some((e) => e.id === b.id)) continue; // replayed record
    const name = typeof b.name === 'string' && b.name ? b.name : '(unnamed)';
    const tools = scan.tools || (scan.tools = {});
    const t = tools[name] || (tools[name] = { count: 0, errors: 0 });
    t.count++;
    ring.push({ id: b.id, name });
    if (ring.length > TOOL_RING) ring.shift();
  }
}

function countToolErrors(scan, content) {
  if (!Array.isArray(content)) return;
  for (const p of content) {
    if (!p || p.type !== 'tool_result' || p.is_error !== true) continue;
    const hit = (scan.toolIds || []).find((e) => e.id === p.tool_use_id);
    const name = hit ? hit.name : '(unknown)';
    const tools = scan.tools || (scan.tools = {});
    const t = tools[name] || (tools[name] = { count: 0, errors: 0 });
    t.errors++;
  }
}
```

Inside `scanLine`, in the existing `else if (line.includes('"type":"assistant"') && line.includes('"usage"'))` branch, change the body so tool counting happens **before** the message-id dedupe and the context figure is recorded **after** it:

```js
    try {
      const rec = JSON.parse(line);
      const m = rec.message;
      if (!m || !m.usage) return;
      if ((m.model || '').startsWith('<')) return; // '<synthetic>' harness records
      countToolUses(scan, m.content); // every record: blocks of one message are split across records
      if (m.id && m.id === scan.lastMsgId) return;
      scan.lastMsgId = m.id || null;
      const model = m.model || 'unknown';
      scan.lastModel = model; // most recent real model = the session's model
      addUsage(scan.usage, model, m.usage);
      scan.lastContext = {
        tokens: (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0),
        model,
        at: rec.timestamp ? Date.parse(rec.timestamp) || null : null,
      };
      // … the existing timestamp / day-bucket code stays exactly as it is …
```

The existing branch only matches assistant lines containing `"usage"`; every assistant record Claude Code writes carries usage, so tool blocks are seen. Keep the rest of the branch (the `lastAssistantTs` and `days` updates) unchanged.

Add a new branch **before** the final `else if (scan.lastAssistantTs && line.includes('"type":"user"') && !line.includes('"tool_use_id"'))` branch:

```js
  } else if (line.includes('"is_error":true') && line.includes('"tool_use_id"')) {
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'user' && rec.message) countToolErrors(scan, rec.message.content);
    } catch {
      /* ignore */
    }
```

(Tool-result lines already fail the reply-time branch's `!line.includes('"tool_use_id"')` test, so this branch does not change reply-time bucketing; the last test pins that.)

In `scanFile`, after `meta.changes = scan.changes || null;` add:

```js
  meta.context = scan.lastContext || null;
  meta.tools = scan.tools || null;
```

Export `TOOL_RING` from `lib/transcripts.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0` (the existing scanLine day-bucket and dedupe tests must still pass).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.js test/pure-logic.test.js
git commit -m "Scanner: last prompt size and per-tool call/error counts, incrementally"
```

---

### Task 3: Summaries, live sessions, and the session usage block

**Files:**
- Modify: `lib/transcripts.js` (add `contextSummary`, `toolSummary`; use them in `usageBreakdown`)
- Modify: `lib/collector.js` (live sessions gain `context` and `tools`)
- Modify: `lib/demo.js` (live sessions and `DEMO_USAGE`)
- Test: `test/pure-logic.test.js` (append; extend the batch A `usageBreakdown` test)

**Interfaces:**
- Consumes: `contextWindow` (Task 1); `meta.context`, `meta.tools` (Task 2).
- Produces:
  - `contextSummary(lastContext) -> { tokens, window, pct } | null` — `tokens` rounded to the nearest 1,000; `window = contextWindow(lastContext.model)`; `pct = Math.min(100, Math.round(tokens / window * 100))` computed from the unrounded tokens; `null` when `lastContext` is missing or has no tokens.
  - `toolSummary(tools, top = 12) -> { total, errors, byName: [{ name, count, errors }] } | null` — `byName` sorted by count desc then name, capped at `top`; `total`/`errors` summed over all names (including `(unknown)`); `null` when there are no entries.
  - `usageBreakdown(meta, pricing)` returns `context: contextSummary(meta.context)` and `tools: toolSummary(meta.tools)`.
  - Each `state.liveSessions[]` entry gains `context: { tokens, window, pct } | null` and `tools: { total, errors } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

In the batch A test `usageBreakdown: per model sorted by cost, subagent share, cache ratio, unpriced flag`, the meta has no `context`/`tools`, so its `assert.equal(u.context, null)` and `assert.equal(u.tools, null)` keep passing unchanged. Add at the end of that test:

```js
  const withCtx = usageBreakdown({ ...meta, context: { tokens: 420_600, model: 'claude-opus-5-5' }, tools: { Bash: { count: 3, errors: 1 } } });
  assert.deepEqual(withCtx.context, { tokens: 421_000, window: 1_000_000, pct: 42 });
  assert.deepEqual(withCtx.tools, { total: 3, errors: 1, byName: [{ name: 'Bash', count: 3, errors: 1 }] });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok" | head -4`
Expected: `contextSummary is not a function` and the `usageBreakdown` addition failing.

- [ ] **Step 3: Implement in `lib/transcripts.js`**

Add `contextWindow` to the existing `require('./pricing')` destructuring. Add after `subagentSummary`:

```js
// How full the context window was on the last turn, rounded so the polled
// state only changes when a displayed figure would. pct is clamped: an
// unknown model gets the 200K default and may read over 100.
function contextSummary(lastContext) {
  if (!lastContext || !lastContext.tokens) return null;
  const window = contextWindow(lastContext.model);
  return {
    tokens: Math.round(lastContext.tokens / 1000) * 1000,
    window,
    pct: Math.min(100, Math.round((lastContext.tokens / window) * 100)),
  };
}

// Tool calls by name with failures, top `top` by count; totals cover all.
function toolSummary(tools, top = 12) {
  const entries = Object.entries(tools || {});
  if (!entries.length) return null;
  let total = 0;
  let errors = 0;
  const byName = entries.map(([name, t]) => {
    total += t.count || 0;
    errors += t.errors || 0;
    return { name, count: t.count || 0, errors: t.errors || 0 };
  });
  byName.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, errors, byName: byName.slice(0, top) };
}
```

In `usageBreakdown`, replace `context: meta.context || null,` and `tools: meta.tools || null,` with:

```js
    context: contextSummary(meta.context),
    tools: toolSummary(meta.tools),
```

Export `contextSummary` and `toolSummary`.

- [ ] **Step 4: Live sessions in the collector**

In `lib/collector.js`, add `contextSummary, toolSummary` to the `require('./transcripts')` destructuring. In `assemble()`, beside the batch A `usageBySession` declaration add:

```js
    const contextBySession = new Map();
    const toolsBySession = new Map();
```

and in the same loop that fills `usageBySession`:

```js
        contextBySession.set(m.sessionId, contextSummary(m.context));
        const ts = toolSummary(m.tools);
        toolsBySession.set(m.sessionId, ts ? { total: ts.total, errors: ts.errors } : null);
```

In the live-session object, after `assumed: report.assumedModels.length > 0,` add:

```js
        context: contextBySession.get(s.sessionId) || null,
        tools: toolsBySession.get(s.sessionId) || null,
```

- [ ] **Step 5: Demo**

In `lib/demo.js` live sessions, add after each `assumed: false,`:
- S1: `context: { tokens: 412000, window: 1000000, pct: 41 }, tools: { total: 142, errors: 3 },`
- S2: `context: { tokens: 731000, window: 1000000, pct: 73 }, tools: { total: 388, errors: 0 },`
- S4: `context: { tokens: 186000, window: 1000000, pct: 19 }, tools: { total: 37, errors: 1 },`

In `DEMO_USAGE` replace `context: null, tools: null` with:

```js
  context: { tokens: 731000, window: 1000000, pct: 73 },
  tools: { total: 388, errors: 0, byName: [{ name: 'Edit', count: 141, errors: 0 }, { name: 'Read', count: 122, errors: 0 }, { name: 'Bash', count: 79, errors: 0 }, { name: 'Grep', count: 46, errors: 0 }] },
```

- [ ] **Step 6: Verify**

`npm test` → `fail 0`. Then `CLAUDE_DASH_PORT=4599 node server.js &` (note the PID; never 4517), and:

```bash
curl -sN http://127.0.0.1:4599/api/events | head -c 300000 | grep -o '"context":{[^}]*},"tools":{[^}]*}' | head -3
```

Expected: one entry per live session that has run tools, e.g. `"context":{"tokens":412000,"window":1000000,"pct":41},"tools":{"total":142,"errors":3}`. The server scans each transcript from offset 0 on start, so running sessions show full counts. Stop the server by PID.

- [ ] **Step 7: Commit**

```bash
git add lib/transcripts.js lib/collector.js lib/demo.js test/pure-logic.test.js
git commit -m "Context and tool summaries on live sessions and the session usage block"
```

---

### Task 4: UI — context meter and tool counts

**Files:**
- Modify: `public/index.html` (CSS after the `.dep-burn` rule ~line 297; `liveCard` ~1092; `mcPaneHead` ~2027)
- Modify: `README.md` (a new bullet after **Session cost breakdown**)

**Interfaces:**
- Consumes: `liveSessions[].context`, `.tools` (Task 3); `/api/session` `usage.context` / `usage.tools` (already rendered by the batch A panel footer — no change there).
- Produces: `fmtCtx(n) -> string`, `contextMeter(ctx) -> html`.

- [ ] **Step 1: CSS**

After the `.dep-burn` rule add:

```css
  .ctx { display: inline-flex; flex-direction: column; gap: 2px; min-width: 64px; }
  .ctx-label { font-size: 10.5px; color: var(--faint); text-align: right; white-space: nowrap; }
  .ctx-bar { height: 3px; background: var(--surface2); border-radius: 2px; overflow: hidden; }
  .ctx-fill { height: 100%; background: var(--accent); }
  .ctx.warn .ctx-fill { background: var(--warn); }
  .ctx.warn .ctx-label { color: var(--warn); }
  .ctx.bad .ctx-fill { background: var(--bad); }
  .ctx.bad .ctx-label { color: var(--bad); }
  .mc-meta.failed { color: var(--warn); }
```

- [ ] **Step 2: Helpers**

Add directly before `function liveCard(s)`:

```js
// 412000 -> "412k", 1000000 -> "1M", 1500000 -> "1.5M".
function fmtCtx(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  return `${Math.round(n / 1000)}k`;
}

// How full the context window was on the last turn: amber from 70%, red from 90%.
function contextMeter(ctx) {
  if (!ctx) return '';
  const level = ctx.pct >= 90 ? 'bad' : ctx.pct >= 70 ? 'warn' : '';
  const tip = 'How much of the context window the last turn used. Claude Code compacts automatically as this fills; a fresh session is cheaper per turn when it is high.';
  return `<span class="ctx ${level}" title="${esc(`${ctx.pct}% — ${tip}`)}">
    <span class="ctx-label">${esc(fmtCtx(ctx.tokens))} / ${esc(fmtCtx(ctx.window))}</span>
    <span class="ctx-bar"><span class="ctx-fill" style="width:${Math.max(0, Math.min(100, Number(ctx.pct) || 0))}%"></span></span>
  </span>`;
}
```

- [ ] **Step 3: Departures row and Mission Control**

In `liveCard(s)`, inside `<div class="dep-right">`, directly after the `${s.estCost != null ? … : ''}` cost block (batch A), add `${contextMeter(s.context)}`.

In `mcPaneHead(s)`, after `${subs}` and before `<span class="spacer"></span>`, add:

```js
${contextMeter(s.context)}${s.tools ? `<span class="mc-meta${s.tools.errors ? ' failed' : ''}" title="tool calls in this session">${s.tools.total} tools${s.tools.errors ? ` · ${s.tools.errors} failed` : ''}</span>` : ''}
```

- [ ] **Step 4: README**

After the **Session cost breakdown** bullet add:

```
- **Context and tools** — each live session shows how full its context window was on the last turn (`412k / 1M`, amber from 70%, red from 90%), so you can see a compaction or a fresh session coming. Mission Control panes add the session's tool-call count with failures in amber, and the transcript's cost panel lists them by tool. Read from the same incremental transcript scan as everything else; subagents are not included.
```

- [ ] **Step 5: Verify**

`npm test` green. `sed -n '/<script>/,/<\/script>/p' public/index.html | sed '1d;$d' > /tmp/claude-dash-ui.js` then `node --check /tmp/claude-dash-ui.js`. Render-level check (no browser in this environment): a scratch script under `/tmp` that extracts `esc`, `fmtCtx`, `contextMeter`, `liveCard`, `mcPaneHead`, `costChip`, `costWording`, `fmtCost`, `modelShort`, `modelChip`, `copyBtn`, `renameBtn` and the `UNPRICED_TIP` const from the inline script by `function NAME(` search (ending at the first `\n}\n`), stubs `lastState`, `elapsed`, `waitLabel`, `statusFlap`, `reasonLine`, and asserts: `contextMeter(null) === ''`; 41% renders `412k / 1M` with no `warn`/`bad`; 73% has class `warn`; 95% has class `bad`; `fmtCtx(1_500_000) === '1.5M'`; a pct of 140 renders `width:100%`; the demo S1 live session's `liveCard` contains `412k / 1M` and its `mcPaneHead` contains `142 tools · 3 failed` with class `failed`; S2's pane head contains `388 tools` without `failed`. Then start `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_PORT=4599 node server.js`, `curl -s http://127.0.0.1:4599/ | grep -c "function contextMeter"` → 1, stop it by PID.

- [ ] **Step 6: Commit**

```bash
git add public/index.html README.md
git commit -m "UI: context window meter on live sessions; tool counts in Mission Control"
```

---

### Task 5: Smoke test on real data

**Files:** none unless a bug turns up.

- [ ] **Step 1:** `npm test` → `fail 0`.
- [ ] **Step 2:** Real mode on 4599 (stop by PID; never 4517): in the first SSE frame, every live session that has an assistant turn carries `context` with `window` 1000000 for 5.x models and a plausible `tokens` (cross-check one against the last assistant record's `input + cache_read + cache_creation` in that session's transcript, read with `tail -c 400000 <file> | grep '"usage"' | tail -1`), and `tools.total > 0` for a session that has run tools.
- [ ] **Step 3:** `/api/session?id=<a live session id>`: `usage.context` equals the live row's `context`; `usage.tools.byName` is sorted by count and its counts sum to at most `usage.tools.total`.
- [ ] **Step 4:** Fingerprint: count SSE pushes for 60 seconds with no session activity (`curl -sN …/api/events | grep -c '^data:'` in the background, then stop it); it must not push every poll.
- [ ] **Step 5:** Browser pass (user, after merge, on 4517): the meter under each departures row and in Mission Control; colours at 70% and 90%; the transcript cost panel footer reads `context … · N tool calls, M failed`.

## Ordering

1 → 2 → 3 → 4 → 5.
