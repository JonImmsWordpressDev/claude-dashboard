# Session Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For any session, list every file Claude edited and show a net diff (original → disk) plus per-edit diffs, using the backups Claude Code already keeps under `~/.claude/file-history/`.

**Architecture:** The incremental transcript scan records `file-history-delta` / `file-history-snapshot` records into a per-session map of path → versions. A dependency-free line diff (`lib/diff.js`) and a small read-only module (`lib/changes.js`) serve `GET /api/session-changes`. The transcript viewer gets a "changes" panel; session rows get a `Δ n` chip.

**Tech Stack:** Node ≥ 18, zero dependencies, `node:test`, vanilla JS in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-09-15-session-changes-design.md`

## Global Constraints

- Never write to anything under `~/.claude`. Backups and project files are read only.
- Zero npm dependencies. The diff is hand-written.
- Transcripts are never fully parsed; the new records ride the existing append-only `incrementalScan`.
- Only `changeCount` (a number) enters the assembled state. The path→version map stays in the scan cache.
- Backup reads are confined to `~/.claude/file-history/<sessionId>/`; backup file names come from the scan map, never from the client. Session ids are validated with `collector.findSession()`.
- Diff limits: 400 KB per side, 2,000 changed lines (`truncated: true` beyond that).
- Work on branch `feature-batch-2026-09`. Run `npm test` before every commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `lib/diff.js` (new) | `diffLines(a, b, opts)` — Myers line diff to unified hunks. Pure. |
| `lib/changes.js` (new) | `recordChange` (pure map update), `changeFiles` (pure ordering), `backupPath` (pure, validated), `sessionChangeList` / `sessionFileDiff` (async, read-only fs). |
| `lib/transcripts.js` | `scanLine` learns the two record types; `scanFile`/`scanSubagents` carry `changes` and `changeCount`. |
| `lib/collector.js` | `changeCount` on session entries (cards, pinned, `allSessions`); `sessionChanges(id)` lookup. |
| `server.js` | `GET /api/session-changes`. Demo branch. |
| `lib/demo.js` | `demoChanges(id, file)` fixture. |
| `public/index.html` | `changes Δ n` button + panel in the transcript viewer; `Δ n` chips; diff CSS. |
| `test/pure-logic.test.js` | Diff, scan, and changes-helper tests. |
| `README.md` | New "Changes" bullet. |

---

### Task 1: Line diff module

**Files:**
- Create: `lib/diff.js`
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces: `diffLines(a: string, b: string, { context = 3, maxChanges = 2000, maxBytes = 400 * 1024 } = {}) -> { hunks, added, removed, truncated, tooLarge }` where each hunk is `{ aStart, aLines, bStart, bLines, lines: [[' '|'+'|'-', text], …] }` (1-based starts, like `@@ -aStart,aLines +bStart,bLines @@`).
- Trailing-newline differences are ignored (both sides are split on `\n` and a final empty element is dropped).

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="diffLines" test/pure-logic.test.js`
Expected: FAIL — `Cannot find module '../lib/diff'`.

- [ ] **Step 3: Write `lib/diff.js`**

```js
'use strict';
// Line diff with no dependencies: Myers O(ND) shortest edit script, then
// unified hunks. Inputs are capped so a pasted vendor bundle can't stall the
// server; beyond maxChanges the result is a truncated replacement block.

const DEFAULTS = { context: 3, maxChanges: 2000, maxBytes: 400 * 1024 };

function splitLines(s) {
  const lines = String(s).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  return lines;
}

// Shortest edit script as ops: [' ', aIdx, bIdx] | ['-', aIdx] | ['+', bIdx].
// Returns null when the edit distance exceeds maxD.
function myers(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const v = new Int32Array(2 * max + 3); // index k + max + 1
  const off = max + 1;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    // Keep only the band this step reads (k-1..k+1 for k in -d..d).
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
    if (d >= maxD) return null;
  }
  return null;
}

function backtrack(trace, a, b, dFinal) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dFinal; d >= 0; d--) {
    const band = trace[d];
    const at = (k) => band[k + d + 1];
    const k = x - y;
    let prevK;
    if (d === 0) prevK = k;
    else if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push([' ', x, y]); }
    if (d > 0) {
      if (x === prevX) { y--; ops.push(['+', y]); }
      else { x--; ops.push(['-', x]); }
    }
  }
  ops.reverse();
  return ops;
}

// Ops → unified hunks with `context` unchanged lines around each change.
function buildHunks(ops, a, b, context) {
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === ' ') { i++; continue; }
    // Change run starts at i; extend while gaps of unchanged lines ≤ 2*context.
    let start = i, end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j][0] !== ' ') { end = j; j++; continue; }
      let gap = 0, k = j;
      while (k < ops.length && ops[k][0] === ' ') { gap++; k++; }
      if (k < ops.length && gap <= 2 * context) { j = k; continue; }
      break;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + 1 + context);
    const lines = [];
    let aStart = null, bStart = null, aLines = 0, bLines = 0;
    for (let p = from; p < to; p++) {
      const op = ops[p];
      if (op[0] === ' ') {
        if (aStart === null) { aStart = op[1] + 1; bStart = op[2] + 1; }
        lines.push([' ', a[op[1]]]); aLines++; bLines++;
      } else if (op[0] === '-') {
        if (aStart === null) { aStart = op[1] + 1; bStart = bIndexAt(ops, p) + 1; }
        lines.push(['-', a[op[1]]]); aLines++;
      } else {
        if (aStart === null) { aStart = aIndexAt(ops, p) + 1; bStart = op[1] + 1; }
        lines.push(['+', b[op[1]]]); bLines++;
      }
    }
    hunks.push({ aStart, aLines, bStart, bLines, lines });
    i = to;
  }
  return hunks;
}

// For a hunk starting on an insert/delete, the other side's position is the
// next index that side reaches (or the count consumed so far).
function aIndexAt(ops, p) {
  for (let q = p; q < ops.length; q++) if (ops[q][0] !== '+') return ops[q][1];
  let consumed = 0;
  for (let q = 0; q < p; q++) if (ops[q][0] !== '+') consumed++;
  return consumed;
}
function bIndexAt(ops, p) {
  for (let q = p; q < ops.length; q++) {
    if (ops[q][0] === ' ') return ops[q][2];
    if (ops[q][0] === '+') return ops[q][1];
  }
  let consumed = 0;
  for (let q = 0; q < p; q++) if (ops[q][0] !== '-') consumed++;
  return consumed;
}

// Fallback when the edit distance blows the cap: common prefix as context,
// then a capped delete/insert block.
function truncatedHunk(a, b, context, maxChanges) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  const half = Math.max(1, Math.floor(maxChanges / 2));
  const lines = [];
  for (let i = Math.max(0, pre - context); i < pre; i++) lines.push([' ', a[i]]);
  const del = a.slice(pre, pre + half);
  const ins = b.slice(pre, pre + half);
  for (const l of del) lines.push(['-', l]);
  for (const l of ins) lines.push(['+', l]);
  const ctx = Math.min(context, pre);
  return {
    hunks: [{ aStart: pre - ctx + 1, aLines: ctx + del.length, bStart: pre - ctx + 1, bLines: ctx + ins.length, lines }],
    added: ins.length,
    removed: del.length,
  };
}

function diffLines(aText, bText, opts = {}) {
  const { context, maxChanges, maxBytes } = { ...DEFAULTS, ...opts };
  const empty = { hunks: [], added: 0, removed: 0, truncated: false, tooLarge: false };
  if (String(aText).length > maxBytes || String(bText).length > maxBytes) return { ...empty, tooLarge: true };
  const a = splitLines(aText), b = splitLines(bText);
  const ops = myers(a, b, maxChanges);
  if (ops === null) return { ...truncatedHunk(a, b, context, maxChanges), truncated: true, tooLarge: false };
  let added = 0, removed = 0;
  for (const op of ops) { if (op[0] === '+') added++; else if (op[0] === '-') removed++; }
  if (!added && !removed) return empty;
  return { hunks: buildHunks(ops, a, b, context), added, removed, truncated: false, tooLarge: false };
}

module.exports = { diffLines };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="diffLines" test/pure-logic.test.js`
Expected: all 10 PASS. If the "distant edits" test's `aStart` values disagree by one, the bug is in `aIndexAt`/`bIndexAt`; fix there, not in the test — the expected values follow directly from the fixture (change at index 2 → context from index 0 → line 1; change at index 17 → context from index 14 → line 15).

- [ ] **Step 5: Sanity-check against real `diff`**

```bash
node -e "
const { diffLines } = require('./lib/diff');
const fs = require('fs');
const a = fs.readFileSync('README.md', 'utf8');
const b = a.replace('Claude Dashboard', 'Claude Board').replace(/\n## Settings\n/, '\n## Settings (edited)\n');
const r = diffLines(a, b);
console.log(r.hunks.length, 'hunks', r.added, 'added', r.removed, 'removed');
for (const h of r.hunks) console.log('@@ -' + h.aStart + ',' + h.aLines + ' +' + h.bStart + ',' + h.bLines + ' @@');
"
```

Expected: at least 2 hunks; line numbers match `grep -n 'Claude Dashboard' README.md | head -1` and `grep -n '^## Settings' README.md` within the 3-line context.

- [ ] **Step 6: Commit**

```bash
git add lib/diff.js test/pure-logic.test.js
git commit -m "Dependency-free line diff with unified hunks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Record file-history entries during the incremental scan

**Files:**
- Create: `lib/changes.js` (pure part)
- Modify: `lib/transcripts.js:171-218` (`scanLine`), `lib/transcripts.js:138-146` (`scanFile` tail), `lib/transcripts.js:266-298` (`scanSubagents`), `lib/transcripts.js:18-53` (`scanAllTranscripts`)
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces (`lib/changes.js`): `recordChange(changes, realPath, { backupFileName, version, backupTime }) -> changes` — mutates and returns the map `{ [realPath]: { versions: [{ v, backup, at }], first, last } }`, deduping by version and keeping versions sorted ascending.
- Produces (`lib/changes.js`): `mergeChanges(target, src) -> target`.
- Produces (`lib/transcripts.js`): `meta.changes` (the map or `null`) and `meta.changeCount` (number) on every session meta, subagent edits merged in.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

`freshScan` and `scanLine` are already imported earlier in the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="recordChange|mergeChanges|file-history|snapshot" test/pure-logic.test.js`
Expected: FAIL — `Cannot find module '../lib/changes'`.

- [ ] **Step 3: Create `lib/changes.js` with the pure helpers**

```js
'use strict';
// Files Claude edited in a session, from the file-history records in the
// transcript, plus read-only access to the backups Claude Code keeps under
// ~/.claude/file-history/<sessionId>/. Pure helpers first; fs code below.
const path = require('path');
const fsp = require('fs/promises');
const { CLAUDE_DIR } = require('./paths');
const { diffLines } = require('./diff');

const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
const BACKUP_NAME = /^[0-9a-f]{8,32}@v\d+$/;

// changes: { [realPath]: { versions: [{ v, backup, at }], first, last } }
function recordChange(changes, realPath, backup) {
  if (!realPath || !backup || !backup.backupFileName) return changes;
  const v = Number(backup.version) || 0;
  const at = backup.backupTime ? Date.parse(backup.backupTime) : NaN;
  const e = changes[realPath] || (changes[realPath] = { versions: [], first: null, last: null });
  if (!e.versions.some((x) => x.v === v)) {
    e.versions.push({ v, backup: String(backup.backupFileName), at: Number.isNaN(at) ? null : at });
    e.versions.sort((x, y) => x.v - y.v);
  }
  if (!Number.isNaN(at)) {
    if (e.first === null || at < e.first) e.first = at;
    if (e.last === null || at > e.last) e.last = at;
  }
  return changes;
}

function mergeChanges(target, src) {
  for (const [p, e] of Object.entries(src || {})) {
    for (const ver of e.versions) {
      recordChange(target, p, { backupFileName: ver.backup, version: ver.v, backupTime: ver.at ? new Date(ver.at).toISOString() : null });
    }
  }
  return target;
}

// Real path for a file-history entry: the key/trackingPath can be an odd
// encoded form, but realParentDir is always the true directory.
function realPathOf(key, backup) {
  if (!backup || !backup.realParentDir || !key) return null;
  return path.join(backup.realParentDir, path.basename(String(key)));
}

module.exports = { recordChange, mergeChanges, realPathOf, FILE_HISTORY_DIR, BACKUP_NAME, diffLines, fsp };
```

(The last three exports are placeholders consumed by Task 3, which replaces this export line.)

- [ ] **Step 4: Teach `scanLine` the two record types**

In `lib/transcripts.js`, add near the top (after the `pricing` require):

```js
const { recordChange, mergeChanges, realPathOf } = require('./changes');
```

In `scanLine`, add two branches **before** the final `else if (scan.lastAssistantTs && …)` branch:

```js
  } else if (line.includes('"type":"file-history-delta"')) {
    try {
      const rec = JSON.parse(line);
      const p = realPathOf(rec.trackingPath, rec.backup);
      if (p) recordChange(scan.changes || (scan.changes = {}), p, rec.backup);
    } catch {
      /* ignore */
    }
  } else if (line.includes('"type":"file-history-snapshot"')) {
    try {
      const rec = JSON.parse(line);
      const tracked = rec.snapshot && rec.snapshot.trackedFileBackups;
      for (const [key, backup] of Object.entries(tracked || {})) {
        const p = realPathOf(key, backup);
        if (p) recordChange(scan.changes || (scan.changes = {}), p, backup);
      }
    } catch {
      /* ignore */
    }
```

- [ ] **Step 5: Surface the map and count on the meta**

In `scanFile`, after `meta.model = scan.lastModel || null;` (line 143) add:

```js
  meta.changes = scan.changes || null;
```

In `scanSubagents`, accumulate subagent edits: add `const totalChanges = {};` beside `const totalDays = {};`, add `mergeChanges(totalChanges, entry.scan.changes);` after `mergeDays(totalDays, entry.scan.days);`, and return `{ usage: total, days: totalDays, changes: totalChanges, count }`.

In `scanAllTranscripts`, after `meta.subagentCount = sub ? sub.count : 0;` add:

```js
          if (sub && sub.changes && Object.keys(sub.changes).length) {
            meta.changes = mergeChanges({ ...(meta.changes || {}) }, sub.changes);
          }
          meta.changeCount = meta.changes ? Object.keys(meta.changes).length : 0;
```

(Spread-copy before merging so the cached `scan.changes` is not mutated by subagent data every rescan.)

- [ ] **Step 6: Run tests and smoke-check**

Run: `npm test` — PASS.

```bash
node -e "
require('./lib/transcripts').scanAllTranscripts().then((s) => {
  const withC = s.filter((m) => m.changeCount).sort((a, b) => b.changeCount - a.changeCount);
  console.log(withC.length, 'sessions with edits; top:', withC.slice(0, 3).map((m) => [m.sessionId.slice(0, 8), m.changeCount]));
  const m = withC[0]; if (m) console.log(Object.entries(m.changes)[0]);
});
"
```

Expected: a non-zero count and a sample `[path, { versions, first, last }]` whose `versions[0].backup` looks like `abcdef0123456789@v1`.

- [ ] **Step 7: Commit**

```bash
git add lib/changes.js lib/transcripts.js test/pure-logic.test.js
git commit -m "Index the files each session edited from file-history records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Read-only change listing and diffs

**Files:**
- Modify: `lib/changes.js` (add fs functions, finalize exports)
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces: `changeFiles(changes) -> [{ n, path, versions, first, last }]` sorted by `last` desc, then path; `n` is the index into that array (stable for a given map).
- Produces: `relPath(abs, root) -> string` — project-relative when inside `root`, else `abs`.
- Produces: `backupPath(sessionId, backupName) -> string | null` — absolute path under `~/.claude/file-history/<sessionId>/`, `null` if either part fails validation.
- Produces: `async sessionChangeList({ sessionId, changes, root }) -> { files: [{ n, path, rel, versions, first, last, exists, added, removed, tooLarge }] }`.
- Produces: `async sessionFileDiff({ sessionId, changes, n, from, to }) -> { path, rel?, from, to, hunks, added, removed, truncated, tooLarge, missingBackup? }`.

- [ ] **Step 1: Write the failing tests**

Append:

```js
const { changeFiles, relPath, backupPath } = require('../lib/changes');

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="changeFiles|relPath|backupPath" test/pure-logic.test.js`
Expected: FAIL — `changeFiles is not a function`.

- [ ] **Step 3: Add the functions and finalize `lib/changes.js`**

Replace the placeholder `module.exports` line in `lib/changes.js` with:

```js
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

function changeFiles(changes) {
  return Object.entries(changes || {})
    .sort((a, b) => (b[1].last || 0) - (a[1].last || 0) || a[0].localeCompare(b[0]))
    .map(([p, e], n) => ({ n, path: p, versions: e.versions, first: e.first, last: e.last }));
}

function relPath(abs, root) {
  const r = String(root || '').replace(/\/+$/, '');
  return r && abs.startsWith(r + '/') ? abs.slice(r.length + 1) : abs;
}

function backupPath(sessionId, backupName) {
  if (!SESSION_ID.test(String(sessionId)) || !BACKUP_NAME.test(String(backupName))) return null;
  return path.join(FILE_HISTORY_DIR, sessionId, backupName);
}

async function readText(abs) {
  try {
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

async function readVersion(sessionId, file, v) {
  const ver = file.versions.find((x) => x.v === v);
  const p = ver && backupPath(sessionId, ver.backup);
  return p ? readText(p) : null;
}

async function sessionChangeList({ sessionId, changes, root }) {
  const files = [];
  for (const f of changeFiles(changes)) {
    const original = await readVersion(sessionId, f, f.versions[0].v);
    const disk = await readText(f.path);
    const d = original === null ? { added: 0, removed: 0, tooLarge: false } : diffLines(original, disk || '');
    files.push({
      n: f.n, path: f.path, rel: relPath(f.path, root),
      versions: f.versions.map((x) => x.v), first: f.first, last: f.last,
      exists: disk !== null, missingBackup: original === null,
      added: d.added, removed: d.removed, tooLarge: !!d.tooLarge,
    });
  }
  return { files };
}

async function sessionFileDiff({ sessionId, changes, n, from, to, root }) {
  const f = changeFiles(changes)[n];
  if (!f) return null;
  const fromV = Number.isInteger(from) ? from : f.versions[0].v;
  const a = await readVersion(sessionId, f, fromV);
  const b = to === 'disk' ? (await readText(f.path)) || '' : await readVersion(sessionId, f, Number(to));
  if (a === null || b === null) return { path: f.path, rel: relPath(f.path, root), from: fromV, to, missingBackup: true, hunks: [], added: 0, removed: 0, truncated: false, tooLarge: false };
  return { path: f.path, rel: relPath(f.path, root), from: fromV, to, ...diffLines(a, b) };
}

module.exports = { recordChange, mergeChanges, realPathOf, changeFiles, relPath, backupPath, sessionChangeList, sessionFileDiff };
```

Remove the now-unused `diffLines, fsp` from the earlier placeholder export (they are used internally only).

- [ ] **Step 4: Run tests and a live smoke-check**

Run: `npm test` — PASS.

```bash
node -e "
const { scanAllTranscripts } = require('./lib/transcripts');
const { sessionChangeList, sessionFileDiff } = require('./lib/changes');
scanAllTranscripts().then(async (s) => {
  const m = s.filter((x) => x.changeCount).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  const list = await sessionChangeList({ sessionId: m.sessionId, changes: m.changes, root: m.cwd });
  console.log(list.files.slice(0, 5));
  const d = await sessionFileDiff({ sessionId: m.sessionId, changes: m.changes, n: 0, to: 'disk', root: m.cwd });
  console.log(d.hunks.length, 'hunks', d.added, d.removed, d.missingBackup);
});
"
```

Expected: file rows with `rel` paths and counts; a diff result (possibly 0 hunks if the file is unchanged since).

- [ ] **Step 5: Commit**

```bash
git add lib/changes.js test/pure-logic.test.js
git commit -m "Read-only change listing and diffs from file-history backups

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Collector and endpoint

**Files:**
- Modify: `lib/collector.js` (session entries at 211–228, pinned at 313–319, `allSessions` at 370–387; new method), `server.js` (imports at 8–20, demo branch at 105–132, new route after `/api/session` at 377)

**Interfaces:**
- Consumes: `sessionChangeList`, `sessionFileDiff` (Task 3); `meta.changes`, `meta.changeCount` (Task 2).
- Produces: `changeCount` on every session entry in state (`projects[].sessions[]`, `pinned[]`, and `/api/project` sessions); `collector.sessionChanges(id) -> { sessionId, changes, root } | null`; `GET /api/session-changes?id=&file=&from=&to=`.

- [ ] **Step 1: Add `changeCount` to session entries**

In `assemble()`, in the `sessions:` map object (lines 213–227), add after `tasksSummary: …`:

```js
            changeCount: m.changeCount || 0,
```

In the pinned push (lines 313–319) add `changeCount: m.changeCount || 0,` after `model: m.model || null,`.

In `allSessions()` (lines 375–385) add `changeCount: m.changeCount || 0,` after `awaySummary: m.awaySummary,`.

- [ ] **Step 2: Add the lookup method**

After `findSession(sessionId)` (after line 534) add:

```js
  // Files a session edited, with its project root for relative display.
  sessionChanges(sessionId) {
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) {
        if (m.sessionId === sessionId) return { sessionId, changes: m.changes || {}, root: g.path };
      }
    }
    return null;
  }
```

- [ ] **Step 3: Add the endpoint**

In `server.js`, import: `const { sessionChangeList, sessionFileDiff } = require('./lib/changes');` after line 14. Add `demoChanges` to the demo import on line 19: `const { demoState, demoStats, demoSession, demoChanges } = require('./lib/demo');`.

In the demo branch, after the `/api/session` case (line 112) add:

```js
    if (url === '/api/session-changes') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      return json(res, 200, demoChanges(q.get('id'), q.get('file')));
    }
```

After the `/api/session` route (after line 377) add:

```js
  if (url === '/api/session-changes') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const found = collector.sessionChanges(params.get('id') || '');
    if (!found) return json(res, 404, { error: 'unknown session' });
    const fileParam = params.get('file');
    const work = fileParam === null
      ? sessionChangeList(found)
      : sessionFileDiff({
          ...found,
          n: Math.max(0, Number(fileParam) || 0),
          from: params.has('from') ? Number(params.get('from')) : undefined,
          to: params.get('to') === null || params.get('to') === 'disk' ? 'disk' : Number(params.get('to')),
        }).then((d) => d || Promise.reject(new Error('unknown file')));
    work
      .then((out) => json(res, 200, { sessionId: found.sessionId, ...out }))
      .catch((e) => json(res, e.message === 'unknown file' ? 404 : 500, { error: String(e.message).slice(0, 200) }));
    return;
  }
```

- [ ] **Step 4: Verify with curl**

Run `node server.js`, then:

```bash
ID=$(curl -s http://127.0.0.1:4517/api/state | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));const m=s.projects.flatMap(p=>p.sessions).find(x=>x.changeCount);console.log(m?m.sessionId:'')")
curl -s "http://127.0.0.1:4517/api/session-changes?id=$ID" | head -c 600; echo
curl -s "http://127.0.0.1:4517/api/session-changes?id=$ID&file=0" | head -c 400; echo
curl -s "http://127.0.0.1:4517/api/session-changes?id=nope" ; echo
curl -s "http://127.0.0.1:4517/api/session-changes?id=$ID&file=999" ; echo
```

Expected: a file list, a diff, `{"error":"unknown session"}`, `{"error":"unknown file"}`.

- [ ] **Step 5: Run tests and commit**

```bash
npm test
git add lib/collector.js server.js
git commit -m "GET /api/session-changes: files a session edited and their diffs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Demo fixture

**Files:**
- Modify: `lib/demo.js` (`sess()` at 20–36, exports at 264, new function)

- [ ] **Step 1: Add `changeCount` to demo sessions**

In `sess()`, add `changeCount: o.changes || 0,` after `tasksSummary`. Give S1 `changes: 3`, S2 `changes: 2`, and the Claude Dashboard "Refresh the README screenshots" session `changes: 4`. Add `changeCount: 2` to the pinned entry.

- [ ] **Step 2: Add `demoChanges`**

```js
// Canned change list + diffs for the transcript viewer's changes panel.
function demoChanges(id, file) {
  const now = Date.now();
  const files = [
    { n: 0, path: '/demo/acme-storefront/src/api/checkout.ts', rel: 'src/api/checkout.ts', versions: [1, 2], first: now - 44 * MIN, last: now - 40 * MIN, exists: true, missingBackup: false, added: 18, removed: 2, tooLarge: false },
    { n: 1, path: '/demo/acme-storefront/src/cart/CartPage.tsx', rel: 'src/cart/CartPage.tsx', versions: [1], first: now - 42 * MIN, last: now - 42 * MIN, exists: true, missingBackup: false, added: 6, removed: 1, tooLarge: false },
    { n: 2, path: '/demo/acme-storefront/src/cart/legacy-checkout.ts', rel: 'src/cart/legacy-checkout.ts', versions: [1], first: now - 41 * MIN, last: now - 41 * MIN, exists: false, missingBackup: false, added: 0, removed: 31, tooLarge: false },
  ];
  if (file === null || file === undefined) return { sessionId: id, files };
  const n = Number(file) || 0;
  const f = files[n] || files[0];
  return {
    sessionId: id, path: f.path, rel: f.rel, from: 1, to: 'disk', added: f.added, removed: f.removed, truncated: false, tooLarge: false,
    hunks: n === 2
      ? [{ aStart: 1, aLines: 4, bStart: 1, bLines: 0, lines: [['-', 'export function legacyCheckout(cart) {'], ['-', '  // replaced by src/api/checkout.ts'], ['-', '  return redirect("/checkout/legacy");'], ['-', '}']] }]
      : [{ aStart: 1, aLines: 5, bStart: 1, bLines: 8, lines: [
          [' ', "import { stripe } from '../lib/stripe';"],
          [' ', ''],
          ['-', 'export async function createCheckout(cart) {'],
          ['-', "  throw new Error('not implemented');"],
          ['+', 'export async function createCheckout(cart: Cart) {'],
          ['+', '  const intent = await stripe.paymentIntents.create({'],
          ['+', '    amount: totalInMinorUnits(cart),'],
          ['+', '    currency: cart.currency,'],
          ['+', '    metadata: { cartId: cart.id },'],
          ['+', '  });'],
          ['+', '  return intent.client_secret;'],
          [' ', '}'],
        ] }],
  };
}
```

Export it: `module.exports = { demoState, demoStats, demoSession, demoChanges };`

- [ ] **Step 3: Commit**

```bash
git add lib/demo.js
git commit -m "Demo mode: canned session changes and diffs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Transcript viewer changes panel and chips

**Files:**
- Modify: `public/index.html` — CSS after `.hl-flash` (line 675); `transcriptStatus` (1487–1498); `openTranscript` (1547–1588); `projectCard` (994–1021), `renderPinned` (1023–1041), `digestItem` (1093–1113), `renderDetail` sessions (1372–1383); the `[data-session]` click handler (2053–2054); new functions after `transcriptStatus`.

**Interfaces:**
- Consumes: `/api/session-changes`, `changeCount` on session entries.
- Produces: `changesChip(sess)`, `openChanges(sessionId)`, `renderChangesPanel(data)`, `loadFileDiff(sessionId, n, from, to)`; `openTranscript(sessionId, highlight, { changes: true })` opens straight to the panel.

- [ ] **Step 1: CSS**

Insert after `.hl-flash { … }` (line 675):

```css
  /* ---------- session changes panel ---------- */
  .badge.changes { color: var(--accent); cursor: pointer; }
  #changes-panel { margin-top: 10px; }
  .chg-file { border: 1px solid var(--line); border-radius: 3px; margin-top: 8px; background: var(--surface); }
  .chg-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; }
  .chg-head .chg-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
  .chg-head .add { color: var(--accent); }
  .chg-head .del { color: var(--bad); }
  .chg-head .badge { flex: none; }
  .chg-body { border-top: 1px solid var(--line); overflow-x: auto; }
  .chg-versions { display: flex; gap: 2px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
  .chg-versions button.sel { background: var(--surface2); color: var(--ink); }
  .diff { font-size: 11.5px; line-height: 1.5; margin: 0; padding: 6px 0; }
  .diff .hh { color: var(--faint); background: var(--surface2); padding: 2px 12px; margin: 4px 0; }
  .diff .dl { display: grid; grid-template-columns: 44px 44px 1fr; white-space: pre; }
  .diff .dl .ln { color: var(--faint); text-align: right; padding-right: 8px; user-select: none; }
  .diff .dl.add { background: var(--accent-bg); }
  .diff .dl.add .tx { color: var(--accent); }
  .diff .dl.del { background: rgba(189, 53, 36, 0.10); }
  .diff .dl.del .tx { color: var(--bad); }
  .diff .dl .tx { padding-left: 8px; }
  .chg-note { color: var(--faint); font-size: 12px; padding: 8px 12px; }
```

- [ ] **Step 2: Chip helper and placements**

Add after `openBtn` (line 953):

```js
// "Δ n" — how many files Claude edited in this session. Opens the changes panel.
function changesChip(sess) {
  if (!sess.changeCount) return '';
  return `<span class="badge changes" data-changes="${esc(sess.sessionId)}" title="${sess.changeCount} file${sess.changeCount === 1 ? '' : 's'} edited — click to see the diffs">Δ ${sess.changeCount}</span>`;
}
```

Insert `${changesChip(sess)}` right after `${modelChip(sess.model)}` in `projectCard`; `${changesChip(p)}` after `${modelChip(p.model)}` in `renderPinned`; `${changesChip(it)}` after `${modelChip(it.model)}` in `digestItem`; and `${changesChip(s)}` after the `s-title` span in `renderDetail`'s session list.

- [ ] **Step 3: Header button and panel functions**

In `transcriptStatus`, add a `changeCount` lookup and button. Replace the function with:

```js
function sessionChangeCount(sid) {
  for (const p of lastState?.projects || []) for (const s of p.sessions) if (s.sessionId === sid) return s.changeCount || 0;
  for (const p of lastState?.pinned || []) if (p.sessionId === sid) return p.changeCount || 0;
  return exportableSession?.changeCount || 0;
}

function transcriptStatus() {
  const liveNow = follow.id && liveIds.has(follow.id);
  const sid = exportableSession && exportableSession.id;
  const isPinned = sid && (lastState?.pinned || []).some((p) => p.sessionId === sid);
  const n = sid ? sessionChangeCount(sid) : 0;
  $('#d-path').textContent = `${follow.projectName} · ${follow.eventCount} events${liveNow ? ' · ● live' : ''}`;
  $('#d-actions').innerHTML = `
    ${n ? `<button class="copy" data-changes-toggle="${esc(sid)}" title="Files Claude edited in this session">changes Δ ${n}</button>` : ''}
    <button class="copy" data-export title="Download this transcript as markdown">export ⇩</button>
    ${sid ? `<button class="copy" data-pin="${esc(sid)}" title="${isPinned ? 'Unpin this session' : 'Pin this session to the top of the dashboard'}">${isPinned ? '★ pinned' : '☆ pin'}</button>` : ''}
    ${!liveNow ? '<button class="copy" data-replay title="Play the conversation back turn by turn">replay ▸</button>' : ''}`;
}

// ---------- changes panel: files edited, net + per-edit diffs ----------
const chg = { sid: null, open: false };

function fmtWhen(ms) {
  return ms ? new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

function changeRow(f) {
  const counts = f.missingBackup ? '<span class="badge">backup gone</span>'
    : f.tooLarge ? '<span class="badge">too large to diff</span>'
    : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
  return `<div class="chg-file" data-n="${f.n}">
    <div class="chg-head" data-chg-open="${f.n}">
      <span class="chg-path" title="${esc(f.path)}">${esc(f.rel)}</span>
      ${f.exists ? '' : '<span class="badge missing">deleted</span>'}
      ${counts}
      <span class="s-when">${f.versions.length} edit${f.versions.length === 1 ? '' : 's'} · ${fmtWhen(f.last)}</span>
    </div>
    <div class="chg-body" hidden></div>
  </div>`;
}

function renderChangesPanel(data) {
  const body = $('#d-body');
  let panel = $('#changes-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'changes-panel';
    body.prepend(panel);
  }
  panel.innerHTML = data.files.length
    ? `<div class="d-section" style="margin-top:0"><summary style="list-style:none">Changes — ${data.files.length} file${data.files.length === 1 ? '' : 's'}</summary>${data.files.map(changeRow).join('')}</div>`
    : '<div class="chg-note">No file edits recorded for this session.</div>';
  panel._files = data.files;
  body.scrollTop = 0;
}

function diffHtml(d) {
  if (d.missingBackup) return '<div class="chg-note">The backup for this version is gone.</div>';
  if (d.tooLarge) return '<div class="chg-note">Too large to diff (over 400 KB).</div>';
  if (!d.hunks.length) return '<div class="chg-note">No differences.</div>';
  const out = ['<pre class="diff">'];
  for (const h of d.hunks) {
    out.push(`<div class="hh">@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@</div>`);
    let a = h.aStart, b = h.bStart;
    for (const [op, text] of h.lines) {
      const cls = op === '+' ? 'add' : op === '-' ? 'del' : 'ctx';
      const la = op === '+' ? '' : a++, lb = op === '-' ? '' : b++;
      out.push(`<div class="dl ${cls}"><span class="ln">${la}</span><span class="ln">${lb}</span><span class="tx">${esc(op + ' ' + text)}</span></div>`);
    }
  }
  out.push('</pre>');
  if (d.truncated) out.push('<div class="chg-note">Diff truncated after 2,000 changed lines.</div>');
  return out.join('');
}

async function loadFileDiff(sid, n, from, to) {
  const file = $(`#changes-panel .chg-file[data-n="${n}"]`);
  if (!file) return;
  const body = file.querySelector('.chg-body');
  const f = ($('#changes-panel')._files || [])[n];
  const versions = f ? f.versions : [];
  const sel = (a, b) => (String(from) === String(a) && String(to) === String(b)) ? ' sel' : '';
  const pairs = [[versions[0], 'disk', 'net']].concat(versions.slice(0, -1).map((v, i) => [v, versions[i + 1], `v${v} → v${versions[i + 1]}`]));
  const buttons = pairs.length > 1
    ? `<div class="chg-versions">${pairs.map(([a, b, label]) => `<button class="copy${sel(a, b)}" data-chg-diff="${n}" data-from="${a}" data-to="${b}">${esc(label)}</button>`).join('')}</div>`
    : '';
  body.hidden = false;
  body.innerHTML = buttons + '<div class="chg-note">Loading…</div>';
  try {
    const r = await fetch(`/api/session-changes?id=${encodeURIComponent(sid)}&file=${n}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!r.ok) throw new Error();
    body.innerHTML = buttons + diffHtml(await r.json());
  } catch {
    body.innerHTML = buttons + '<div class="chg-note">Couldn\'t load the diff.</div>';
  }
}

async function openChanges(sid) {
  chg.sid = sid;
  chg.open = true;
  try {
    const r = await fetch(`/api/session-changes?id=${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error();
    renderChangesPanel(await r.json());
  } catch {
    renderChangesPanel({ files: [] });
  }
}

function closeChanges() {
  chg.open = false;
  const panel = $('#changes-panel');
  if (panel) panel.remove();
}
```

- [ ] **Step 4: Open the panel from chips and the header button; per-file toggles**

Change `openTranscript`'s signature to `async function openTranscript(sessionId, highlight, opts = {})` and, after `transcriptStatus();` inside the try block, add:

```js
    exportableSession.changeCount = sessionChangeCount(sessionId);
    if (opts.changes) await openChanges(sessionId);
```

In the document click handler at lines 2051–2054, add before the `[data-session]` branch:

```js
  const cc = e.target.closest('[data-changes]');
  if (cc) { openTranscript(cc.dataset.changes, null, { changes: true }); return; }
  const ct = e.target.closest('[data-changes-toggle]');
  if (ct) { chg.open ? closeChanges() : openChanges(ct.dataset.changesToggle); return; }
  const co = e.target.closest('[data-chg-open]');
  if (co) {
    const bodyEl = co.parentElement.querySelector('.chg-body');
    if (!bodyEl.hidden) { bodyEl.hidden = true; return; }
    const f = ($('#changes-panel')._files || [])[Number(co.dataset.chgOpen)];
    loadFileDiff(chg.sid, Number(co.dataset.chgOpen), f ? f.versions[0] : 1, 'disk');
    return;
  }
  const cd = e.target.closest('[data-chg-diff]');
  if (cd) { loadFileDiff(chg.sid, Number(cd.dataset.chgDiff), cd.dataset.from, cd.dataset.to); return; }
```

Also make `openDrawerShell` reset the panel state: add `chg.open = false; chg.sid = null;` after `$('#d-actions').innerHTML = '';` (the panel lives inside `#d-body`, which is replaced anyway).

- [ ] **Step 5: Check it in demo mode, then live**

Run: `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_DEV=1 node server.js`. Expected: `Δ 3` chip on the Acme Storefront "Wire Stripe checkout" row; clicking it opens the transcript with the changes panel at the top listing three files, the third marked `deleted`; clicking a file shows a coloured unified diff with line numbers; the `changes Δ 3` header button toggles the panel. Then run without demo mode and open a recent session with a chip: the real file list and diffs load, and `net` / `v1 → v2` buttons switch views.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Changes panel: every file a session edited, with net and per-edit diffs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README

**Files:**
- Modify: `README.md` — add a bullet after "Export" (line 96)

- [ ] **Step 1: Add the bullet**

```
- **Changes** — a `Δ n` chip on any session row counts the files Claude edited. Click it (or `changes` in the transcript header) for the list with `+added −removed` per file and a unified diff of what the session changed, from the pre-edit backup Claude Code keeps to the file as it is on disk now. Multi-edit files also offer each individual edit (`v1 → v2`). Read-only: nothing here reverts anything.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: session changes and diffs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: record types and per-path versions (Task 2); subagent merge (Task 2 step 5); only `changeCount` in state (Task 4); diff module with limits and hunks (Task 1); endpoint parameters, validation, confinement (Tasks 3–4); panel, chips, version selector, deleted and missing-backup rows (Task 6); demo (Task 5); tests (Tasks 1–3); README (Task 7).
- Deviation from spec, deliberate: trailing-newline differences are ignored rather than flagged, since a flag with no UI treatment is noise. Recorded in Task 1's interface note.
- Names used consistently: `recordChange`, `mergeChanges`, `realPathOf`, `changeFiles`, `relPath`, `backupPath`, `sessionChangeList`, `sessionFileDiff`, `sessionChanges` (collector), `changeCount`, `changesChip`, `openChanges`, `loadFileDiff`.
