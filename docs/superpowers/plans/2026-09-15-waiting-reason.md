# Waiting Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a live session is waiting on the user, show *what* it is waiting for (a question, a permission prompt, or a reply) on the departures board, in notifications, and in the catch-up log.

**Architecture:** A pure function in `lib/transcripts.js` derives the reason from the already-parsed transcript tail records. `scanFile` stores it on the session meta; the collector exposes it only for sessions whose live status is `waiting`, and uses the same text for notifications. The UI renders a second line under the session title.

**Tech Stack:** Node ≥ 18, zero dependencies, `node:test`, vanilla JS in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-09-15-waiting-reason-design.md`

## Global Constraints

- Never write to anything under `~/.claude`. All reads are read-only.
- Zero npm dependencies.
- Transcript files are never fully parsed. This feature only uses the tail buffer `scanFile` already reads (`TAIL_BYTES = 16 * 1024`).
- Anything that enters the assembled state must be stable between polls (trim, collapse whitespace, cap length) so the JSON fingerprint does not churn.
- Work on branch `feature-batch-2026-09`. Run `npm test` before every commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Change |
|---|---|
| `lib/transcripts.js` | New exported pure functions `waitingReason(records)` and `reasonText(reason)`; `scanFile` collects parsed tail records and stores `meta.waitingReason`. |
| `lib/collector.js` | Live session entries gain `waitingReason`; notification and catch-up bodies use `reasonText`. |
| `public/index.html` | `reasonLine()` helper, second line in `liveCard`, tooltip in `statusFlap`, reason in Mission Control pane, CSS `.dep-reason`. |
| `lib/demo.js` | Demo waiting session gets a question reason; a new live session shows a permission reason. |
| `test/pure-logic.test.js` | Tests for `waitingReason` and `reasonText`. |
| `README.md` | Departures and Notifications bullets mention the reason line. |

---

### Task 1: `waitingReason` pure function

**Files:**
- Modify: `lib/transcripts.js` (add after `cleanPrompt`, before the subagent section at line 262; extend `module.exports` at line 391)
- Test: `test/pure-logic.test.js` (append at end)

**Interfaces:**
- Produces: `waitingReason(records: object[]) -> { kind: 'question'|'permission'|'reply', text: string, options?: string[] } | null`. `records` are parsed transcript records in file order (oldest first).
- Produces: `reasonText(reason) -> string` — the single-line body for notifications and the catch-up log. Returns `'Claude is waiting for your input'` when `reason` is null.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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

test('reasonText formats each kind for a notification body', () => {
  assert.equal(reasonText({ kind: 'question', text: 'Which one?', options: ['a', 'b'] }), 'Which one? (a / b)');
  assert.equal(reasonText({ kind: 'question', text: 'Which one?', options: [] }), 'Which one?');
  assert.equal(reasonText({ kind: 'permission', text: 'Bash npm test' }), 'permission: Bash npm test');
  assert.equal(reasonText({ kind: 'reply', text: 'Shall I continue?' }), 'Shall I continue?');
  assert.equal(reasonText(null), 'Claude is waiting for your input');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="waitingReason|reasonText" test/pure-logic.test.js`
Expected: FAIL — `waitingReason is not a function`.

- [ ] **Step 3: Implement `waitingReason` and `reasonText`**

Insert into `lib/transcripts.js` immediately before the line `// Subagent transcripts live beside the main file; their tokens are real` (line 262):

```js
// ---------- what a waiting session is waiting for ----------
// Derived from the parsed tail records (oldest first). "Last turn" = every
// record after the last real user prompt (tool_results and harness noise
// don't start a turn). Pure so it's unit-testable.
const REASON_TEXT_CAP = 200;
const PERMISSION_CAP = 120;
const OPTION_CAP = 40;
const MAX_OPTIONS = 6;

function clip(s, n) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, n);
}

function toolResultIds(rec) {
  const out = [];
  const c = rec.message && rec.message.content;
  if (!Array.isArray(c)) return out;
  for (const p of c) if (p && p.type === 'tool_result' && p.tool_use_id) out.push(p.tool_use_id);
  return out;
}

function isRealPrompt(rec) {
  return rec.type === 'user' && !!rec.message && toolResultIds(rec).length === 0 && !!extractUserText(rec);
}

// The most readable single argument of a tool call, for permission prompts.
function toolArg(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'skill', 'prompt', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

// Strip list markers, headings, quotes, and inline emphasis from one line.
function plainLine(line) {
  return line.replace(/^[\s#>*\-•]+|^\s*\d+[.)]\s+/g, '').replace(/[*_`]/g, '').trim();
}

function replyLine(text) {
  const lines = String(text).split('\n').map(plainLine).filter(Boolean);
  if (!lines.length) return null;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].endsWith('?')) return lines[i];
  const paragraphs = String(text).split(/\n\s*\n/).map((p) => p.split('\n').map(plainLine).filter(Boolean)).filter((p) => p.length);
  const last = paragraphs[paragraphs.length - 1];
  return last ? last[0] : lines[lines.length - 1];
}

function waitingReason(records) {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (isRealPrompt(records[i])) { start = i + 1; break; }
  }
  const turn = records.slice(start);
  const answered = new Set();
  for (const r of turn) if (r.type === 'user') for (const id of toolResultIds(r)) answered.add(id);

  let lastText = null;
  let pendingTool = null;
  let pendingQuestion = null;
  for (const r of turn) {
    if (r.type !== 'assistant' || r.isSidechain || !r.message || !Array.isArray(r.message.content)) continue;
    for (const p of r.message.content) {
      if (!p) continue;
      if (p.type === 'text' && p.text && p.text.trim()) lastText = p.text;
      else if (p.type === 'tool_use' && p.id && !answered.has(p.id)) {
        if (p.name === 'AskUserQuestion') pendingQuestion = p;
        else pendingTool = p;
      }
    }
  }

  if (pendingQuestion) {
    const q = (pendingQuestion.input && Array.isArray(pendingQuestion.input.questions) && pendingQuestion.input.questions[0]) || {};
    const options = Array.isArray(q.options)
      ? q.options.map((o) => clip(o && o.label, OPTION_CAP)).filter(Boolean).slice(0, MAX_OPTIONS)
      : [];
    return { kind: 'question', text: clip(q.question || 'Claude asked a question', REASON_TEXT_CAP), options };
  }
  if (pendingTool) {
    return { kind: 'permission', text: clip(`${pendingTool.name || 'tool'} ${toolArg(pendingTool.input)}`, PERMISSION_CAP) };
  }
  if (lastText) {
    const line = replyLine(lastText);
    if (line) return { kind: 'reply', text: clip(line, REASON_TEXT_CAP) };
  }
  return null;
}

// One-line body for notifications and the catch-up log.
function reasonText(reason) {
  if (!reason) return 'Claude is waiting for your input';
  if (reason.kind === 'question') {
    const opts = reason.options && reason.options.length ? ` (${reason.options.join(' / ')})` : '';
    return `${reason.text}${opts}`;
  }
  if (reason.kind === 'permission') return `permission: ${reason.text}`;
  return reason.text;
}
```

Extend `module.exports` at the bottom of `lib/transcripts.js`:

```js
module.exports = {
  scanAllTranscripts, groupByProject, sessionTitle, combinedUsage, mergeUsage,
  scanLine, mergeDays, combinedDays, dailyCostSeries, subagentSummary, dayKey,
  waitingReason, reasonText,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="waitingReason|reasonText" test/pure-logic.test.js`
Expected: all 13 PASS. Then `npm test` — everything green.

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.js test/pure-logic.test.js
git commit -m "Derive what a waiting session is waiting for from the transcript tail

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Store the reason on session meta during the tail read

**Files:**
- Modify: `lib/transcripts.js:119-136` (the tail loop in `scanFile`) and `lib/transcripts.js:80-92` (the `meta` object)

**Interfaces:**
- Consumes: `waitingReason(records)` from Task 1.
- Produces: `meta.waitingReason` on every scanned session meta (`null` when nothing is derivable). The collector reads it in Task 3.

- [ ] **Step 1: Collect parsed tail records and compute the reason**

Replace the tail loop (lines 119–136) with:

```js
  // Tail: last complete lines carry last-prompt / away_summary, and the
  // final turn tells us what a waiting session is waiting for.
  const tailLines = tail.split('\n').filter((l) => l.trim());
  const tailRecords = [];
  for (let i = tailLines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(tailLines[i]);
    } catch {
      continue; // first tail line is usually a partial record
    }
    tailRecords.push(rec);
    if (meta.lastPrompt === null && rec.type === 'last-prompt' && rec.lastPrompt) {
      meta.lastPrompt = String(rec.lastPrompt).slice(0, 200);
    }
    if (meta.awaySummary === null && rec.type === 'system' && rec.subtype === 'away_summary' && rec.content) {
      meta.awaySummary = String(rec.content).slice(0, 800);
      const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      meta.awaySummaryAt = Number.isNaN(t) ? null : t;
    }
  }
  tailRecords.reverse(); // file order, oldest first
  meta.waitingReason = waitingReason(tailRecords);
```

Add `waitingReason: null,` to the `meta` object literal (after `aiTitle: null,` at line 91).

- [ ] **Step 2: Smoke-check against real data**

Run:

```bash
node -e "
const { scanAllTranscripts } = require('./lib/transcripts');
scanAllTranscripts().then((s) => {
  const withReason = s.filter((m) => m.waitingReason);
  console.log(s.length, 'sessions,', withReason.length, 'with a reason');
  for (const m of withReason.slice(0, 5)) console.log(m.sessionId.slice(0, 8), JSON.stringify(m.waitingReason));
});
"
```

Expected: a count line and up to five `{kind, text}` samples. No exceptions. (Most finished sessions end with a reply, so most will have `kind: 'reply'`; that's expected — the collector only exposes it for waiting sessions.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/transcripts.js
git commit -m "Keep the derived waiting reason on each session meta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Expose the reason in state, notifications, and the catch-up log

**Files:**
- Modify: `lib/collector.js:10` (import), `lib/collector.js:111-127` (`notifyTransitions`), `lib/collector.js:239-249` (per-session maps), `lib/collector.js:284-303` (live entry)

**Interfaces:**
- Consumes: `meta.waitingReason` (Task 2), `reasonText` (Task 1).
- Produces: each entry of `state.liveSessions[]` gains `waitingReason: {kind, text, options?} | null`. Notification bodies and catch-up entries carry `reasonText(reason)`.

- [ ] **Step 1: Import `reasonText`**

Change line 10 to:

```js
const { scanAllTranscripts, groupByProject, sessionTitle, combinedUsage, combinedDays, dailyCostSeries, subagentSummary, dayKey, reasonText } = require('./transcripts');
```

- [ ] **Step 2: Add a lookup helper on the collector**

Add this method after `titleOf(m)` (after line 171):

```js
  // What a session is waiting for: the session file's own waitingFor when
  // Claude Code populates it, else the reason derived from the transcript.
  reasonFor(s) {
    if (s.waitingFor) return { kind: 'reply', text: String(s.waitingFor).slice(0, 200) };
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) if (m.sessionId === s.sessionId) return m.waitingReason || null;
    }
    return null;
  }
```

- [ ] **Step 3: Use it in `notifyTransitions`**

Replace lines 114–125 with:

```js
    for (const id of newlyWaiting(prev, next)) {
      const s = live.find((x) => x.sessionId === id);
      const root = worktreeRoot(s.cwd).root;
      const body = reasonText(this.reasonFor(s));
      this.logEvent('needs you', friendlyName(root), body);
      if (isProjectMuted(root, readConfig().mutedProjects)) continue;
      const project = friendlyName(root);
      sendNotification({ title: `${project} needs you`, body, sound: 'Glass' });
    }
```

- [ ] **Step 4: Add `waitingReason` to the live entry**

In the `liveSessions` map (the object returned around lines 284–303), add after `waitingFor: s.waitingFor,`:

```js
        waitingReason: s.status === 'waiting' ? this.reasonFor(s) : null,
```

- [ ] **Step 5: Verify the state shape**

Run: `node server.js` in one terminal, then in another:

```bash
curl -s http://127.0.0.1:4517/api/state | node -e "
const s = JSON.parse(require('fs').readFileSync(0, 'utf8'));
for (const l of s.liveSessions) console.log(l.projectName, l.status, JSON.stringify(l.waitingReason));
"
```

Expected: one line per live session; `waitingReason` is `null` for busy sessions and an object for waiting ones. Stop the server.

- [ ] **Step 6: Run tests and commit**

Run: `npm test` — PASS.

```bash
git add lib/collector.js
git commit -m "Carry the waiting reason into state, notifications, and catch-up

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Render the reason on the board and in Mission Control

**Files:**
- Modify: `public/index.html` — CSS after `.dep-task .count` (line 286); JS `statusFlap` (line 908), `liveCard` (line 968), `mcSync` (line 1653–1656)

**Interfaces:**
- Consumes: `s.waitingReason` from state.
- Produces: `reasonLine(reason) -> { glyph, short, full }` client helper.

- [ ] **Step 1: Add CSS**

Insert after line 286 (`.dep-task .count { … }`):

```css
  .dep-reason {
    margin-top: 2px; font-size: 11.5px; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dep-reason .glyph { color: var(--warn); margin-right: 6px; font-weight: 600; }
  .dep-reason .opts { color: var(--faint); }
```

- [ ] **Step 2: Add the `reasonLine` helper and use it in `statusFlap`**

Insert before `function statusFlap` (line 908):

```js
// One display line for what a waiting session needs: glyph + 80-char text,
// plus the untruncated version for tooltips.
function reasonLine(r) {
  if (!r || !r.text) return null;
  const glyph = r.kind === 'question' ? '?' : r.kind === 'permission' ? '🔒' : '';
  const opts = r.kind === 'question' && r.options && r.options.length ? r.options.join(' / ') : '';
  const full = opts ? `${r.text} · ${opts}` : r.text;
  const short = full.length > 80 ? full.slice(0, 79) + '…' : full;
  return { glyph, short, full, opts, text: r.text };
}
```

In `statusFlap`, change the waiting branch to:

```js
  if (s.status === 'waiting') {
    const rl = reasonLine(s.waitingReason);
    return `<span class="flap disp st st-waiting${flip}" title="${esc(rl ? rl.full : 'Claude is waiting for your input')}">needs you</span>`;
  }
```

- [ ] **Step 3: Add the line to `liveCard`**

In `liveCard`, after the `const task = …` block, add:

```js
  const rl = s.status === 'waiting' ? reasonLine(s.waitingReason) : null;
  const reason = rl
    ? `<div class="dep-reason" title="${esc(rl.full)}">${rl.glyph ? `<span class="glyph">${rl.glyph}</span>` : ''}${esc(rl.text.length > 80 ? rl.text.slice(0, 79) + '…' : rl.text)}${
        rl.opts && rl.text.length < 60 ? ` <span class="opts">· ${esc(rl.opts.slice(0, 80 - rl.text.length))}</span>` : ''}</div>`
    : '';
```

and change the `dep-mid` block to render it under the task line:

```js
    <div class="dep-mid">
      <div class="dep-title" data-session="${esc(s.sessionId)}" title="Click to watch the transcript live">${esc(s.title || '')}</div>
      ${task}
      ${reason}
    </div>
```

- [ ] **Step 4: Show it in Mission Control**

In `mcSync`, replace the three `taskEl` lines (1653–1656) with:

```js
    const taskEl = pane.el.querySelector('.mc-pane-task');
    const rl = s.status === 'waiting' ? reasonLine(s.waitingReason) : null;
    const taskHtml = rl
      ? `<span class="prompt-ch" style="color:var(--warn)">${rl.glyph || '›'}</span>${esc(rl.short)}`
      : s.currentTask ? `<span class="prompt-ch">❯</span>${esc(s.currentTask.activeForm)}` : '';
    patch(taskEl, taskHtml);
    taskEl.hidden = !taskHtml;
```

- [ ] **Step 5: Check it in the browser**

Run: `CLAUDE_DASH_DEV=1 node server.js`, open http://127.0.0.1:4517. If a real session is waiting, its row shows the second line. Otherwise proceed to Task 5 (demo mode) to see it rendered. Confirm busy rows are unchanged in height.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Show what a waiting session needs under its title on the board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Demo fixtures

**Files:**
- Modify: `lib/demo.js:12-14` (ids), `lib/demo.js:66-84` (live sessions), `lib/demo.js:117-125` (Data Pipeline project), `lib/demo.js:218-241` (`demoSession`)

- [ ] **Step 1: Add a fourth session id**

After line 14 add:

```js
const S4 = 'demo4444-4444-4444-8444-444444444444';
```

- [ ] **Step 2: Give the waiting session a question and add a permission example**

In `liveSessions`, add to the S1 entry after `waitingFor: …`:

```js
        waitingReason: { kind: 'question', text: 'Which payment provider should checkout use for the wallet flow?', options: ['Payment Request Button', 'Native per wallet'] },
```

Add `waitingReason: null,` to the S2 entry after `waitingFor: null,`. Then append a third live entry after S2:

```js
      {
        sessionId: S4, pid: 4444, cwd: '/demo/data-pipeline', projectPath: '/demo/data-pipeline',
        projectName: 'Data Pipeline', isWorktree: false, model: 'claude-sonnet-5',
        title: 'Backfill the analytics warehouse', status: 'waiting',
        waitingFor: null,
        waitingReason: { kind: 'permission', text: 'Bash node scripts/backfill.mjs --apply --from 2026-01-01' },
        startedAt: now - 22 * MIN, statusUpdatedAt: now - 2 * MIN, quietMin: null,
        currentTask: { activeForm: 'Applying the backfill' }, tasksSummary: { completed: 4, inProgress: 1, pending: 4 },
        subagents: null, resumeCommand: 'claude --resume demo',
      },
```

- [ ] **Step 3: Make Data Pipeline look live**

Change the Data Pipeline `mk(…)` call: `5 * HOUR` → `2 * MIN`, and its first session to `sess(now, { id: S4, ago: 2 * MIN, cost: 9.15, model: 'claude-sonnet-5', title: 'Backfill the analytics warehouse', tasks: { completed: 4, inProgress: 1, pending: 4 } })` (drop the `summary`, the session is still running).

- [ ] **Step 4: Add a transcript for S4**

In `demoSession`, add before `return {` (the S1 fallback):

```js
  if (id === S4) return pipelineSession(now, after);
```

And add after `blogSession`:

```js
function pipelineSession(now, after) {
  return {
    sessionId: S4,
    title: 'Backfill the analytics warehouse',
    projectName: 'Data Pipeline',
    truncatedTurns: 0,
    nextOffset: 1,
    events: after ? [] : [
      { kind: 'user', ts: now - 22 * MIN, text: 'Backfill the warehouse from January. Dry-run first, then apply.' },
      { kind: 'tool', ts: now - 20 * MIN, name: 'Bash', input: 'node scripts/backfill.mjs --dry-run --from 2026-01-01' },
      { kind: 'assistant', ts: now - 6 * MIN, text: 'Dry run is clean: 1.2M rows, no schema drift. Applying now — this writes to the warehouse, so it needs your approval.' },
      { kind: 'tool', ts: now - 2 * MIN, name: 'Bash', input: 'node scripts/backfill.mjs --apply --from 2026-01-01' },
    ],
  };
}
```

- [ ] **Step 5: Check demo mode**

Run: `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_DEV=1 node server.js` and open the dashboard. Expected: three departures rows; Acme Storefront shows `? Which payment provider … · Payment Request Button / Native per wallet`; Data Pipeline shows `🔒 Bash node scripts/backfill.mjs …`; Blog Engine has no reason line. Open Mission Control and confirm the same text in the two waiting panes.

- [ ] **Step 6: Commit**

```bash
git add lib/demo.js
git commit -m "Demo mode: a question and a permission prompt on the board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: README

**Files:**
- Modify: `README.md:78` (Departures bullet), `README.md:108` (Notifications bullet)

- [ ] **Step 1: Update the two bullets**

Departures bullet: append after "readable from across the room.":

```
 A second line under the title says what it needs: `?` for a question Claude asked (with its options), `🔒` for a tool call awaiting permission (with the command or file), or the last sentence of Claude's reply.
```

Notifications bullet: replace "naming the project." with:

```
naming the project and what it needs — the question, the command awaiting permission, or Claude's last line.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: the waiting reason line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: three kinds and `null` (Task 1); `waitingFor` precedence (Task 3 `reasonFor`); only-for-waiting exposure (Task 3); truncation and stable text (Task 1 `clip`); departures line with glyph, options, 80-char cap and tooltip (Task 4); Mission Control (Task 4); notifications and catch-up (Task 3); demo (Task 5); tests (Task 1). README (Task 6).
- The spec's "computed only for waiting sessions" is met at the exposure layer: the derivation runs on tail records `scanFile` parses anyway, costs a few comparisons, and is cached with the meta by (mtime, size).
- Names used consistently: `waitingReason`, `reasonText`, `reasonFor`, `reasonLine`.
