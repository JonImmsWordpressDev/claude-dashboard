# Session Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach a free-text note to any session, edit it from the transcript viewer, see a marker on session rows, and find notes through search.

**Architecture:** Notes live in `config.json` under `sessionNotes`, mirroring the existing `sessionNames` pattern in `lib/config.js`. A same-origin `POST /api/session-note` writes them; the collector reads them into every session entry as `note`. The transcript viewer gets a `note` button with a textarea; rows get a `≡` marker; `lib/search.js` gains `searchNotes`.

**Tech Stack:** Node ≥ 18, zero dependencies, `node:test`, vanilla JS in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-09-15-session-notes-design.md`

## Global Constraints

- Never write to anything under `~/.claude`. Notes are written only to the dashboard's own `config.json` (pretty-printed, hand-editable).
- Zero npm dependencies.
- POST endpoints enforce same-origin via the existing `sameOrigin(req)`; session ids are validated with `collector.findSessionFile()`.
- Notes are trimmed and capped at 2,000 characters; empty deletes.
- Work on branch `feature-batch-2026-09`. Run `npm test` before every commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Change |
|---|---|
| `lib/config.js` | `sessionNotes: {}` default; `applySessionNote` (pure) and `setSessionNote`. |
| `server.js` | `POST /api/session-note`; `/api/session` response includes `note`; `/api/search` includes `notes`. |
| `lib/collector.js` | `note` on session entries (cards, pinned, `allSessions`) and on `findSessionFile`. |
| `lib/search.js` | `searchNotes(q, transcriptGroups, sessionNotes)`. |
| `public/index.html` | `noteMark()` on rows; `note` button + textarea in the transcript header; search section. |
| `test/pure-logic.test.js` | `applySessionNote`, `searchNotes`. |
| `README.md` | Bullet under "What you're looking at" and one under Settings. |

---

### Task 1: Config storage

**Files:**
- Modify: `lib/config.js:36` (DEFAULTS), after `setSessionName` (line 114), exports (218–236)
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces: `applySessionNote(sessionNotes, sessionId, note) -> object` (pure, non-mutating; trims; caps at 2000; empty deletes).
- Produces: `setSessionNote(sessionId, note) -> string` (writes `config.json`, returns the stored note or `''`).

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="applySessionNote" test/pure-logic.test.js`
Expected: FAIL — `applySessionNote is not a function`.

- [ ] **Step 3: Implement**

Change `DEFAULTS` (line 36) to include `sessionNotes: {}`:

```js
const DEFAULTS = { terminal: 'ghostty', notifications: true, usageApi: true, mutedProjects: [], weeklyBudget: 0, pinnedSessions: [], sessionNames: {}, sessionNotes: {}, theme: 'board' };
```

Add after `setSessionName` (after line 114):

```js
// Pure: returns a new sessionNotes map with `note` set for `sessionId`
// (trimmed, capped at 2000 chars); an empty note removes the entry.
const NOTE_CAP = 2000;
function applySessionNote(sessionNotes, sessionId, note) {
  const next = { ...(sessionNotes || {}) };
  const clean = String(note || '').trim().slice(0, NOTE_CAP);
  if (clean) next[sessionId] = clean;
  else delete next[sessionId];
  return next;
}

function setSessionNote(sessionId, note) {
  const next = { ...readConfig() };
  next.sessionNotes = applySessionNote(next.sessionNotes, sessionId, note);
  writeJson(CONFIG_FILE, next);
  return next.sessionNotes[sessionId] || '';
}
```

Add `applySessionNote, setSessionNote,` to `module.exports` after `setSessionName,`.

- [ ] **Step 4: Run tests, commit**

Run: `npm test` — PASS.

```bash
git add lib/config.js test/pure-logic.test.js
git commit -m "Session notes stored in config.json beside session names

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Endpoint and state

**Files:**
- Modify: `server.js` (new route after the `/api/config` POST block, line 323; `/api/session` response at line 370), `lib/collector.js` (assemble at 175 and 213–227, pinned 313–319, `allSessions` 375–385, `findSessionFile` 512–521)

**Interfaces:**
- Consumes: `setSessionNote` (Task 1).
- Produces: `POST /api/session-note { id, note } -> { ok, note }`; `note: string|null` on every session entry in state and in `/api/session`.

- [ ] **Step 1: Collector reads notes once per assemble**

In `assemble()`, after line 175 (`const sessionNames = …`) add:

```js
    const sessionNotes = readConfig().sessionNotes || {};
```

Add `note: sessionNotes[m.sessionId] || null,` to: the `sessions:` map object (after `tasksSummary`), the pinned push (after `model`), and in `allSessions()` (after `awaySummary`) — in `allSessions`, read notes locally: `const notes = readConfig().sessionNotes || {};` at the top of the method and use `notes[m.sessionId] || null`.

In `findSessionFile`, extend the returned object:

```js
          return { file: m.file, title: this.titleOf(m).title, projectName: friendlyName(g.path), note: (readConfig().sessionNotes || {})[m.sessionId] || null };
```

- [ ] **Step 2: Endpoint**

In `server.js`, after the block ending at line 323 (`return;` of the config/names/ignore POST handler), add:

```js
  if (url === '/api/session-note' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' });
    readBody(req, res, (payload) => {
      const id = String(payload.id || '');
      if (!collector.findSessionFile(id)) return json(res, 404, { ok: false, error: 'unknown session' });
      const note = cfg.setSessionNote(id, String(payload.note || ''));
      collector.assemble();
      json(res, 200, { ok: true, note });
    });
    return;
  }
```

In the `/api/session` handler (line 370), include the note:

```js
        res.end(JSON.stringify({ sessionId: id, title: found.title, projectName: found.projectName, note: found.note || null, ...t }));
```

- [ ] **Step 3: Verify with curl**

Run `node server.js`, then:

```bash
ID=$(curl -s http://127.0.0.1:4517/api/state | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(s.projects[0].sessions[0].sessionId)")
curl -s -X POST -H 'Content-Type: application/json' -d "{\"id\":\"$ID\",\"note\":\"test note\"}" http://127.0.0.1:4517/api/session-note; echo
curl -s "http://127.0.0.1:4517/api/session?id=$ID" | head -c 200; echo
curl -s -X POST -H 'Content-Type: application/json' -H 'Origin: http://evil.example' -d '{}' http://127.0.0.1:4517/api/session-note; echo
curl -s -X POST -H 'Content-Type: application/json' -d "{\"id\":\"$ID\",\"note\":\"\"}" http://127.0.0.1:4517/api/session-note; echo
```

Expected: `{"ok":true,"note":"test note"}`, a session payload containing `"note":"test note"`, `{"ok":false,"error":"forbidden"}`, `{"ok":true,"note":""}`. Confirm `config.json` no longer has the key after the last call.

- [ ] **Step 4: Run tests, commit**

```bash
npm test
git add server.js lib/collector.js
git commit -m "POST /api/session-note and note on every session entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Search notes

**Files:**
- Modify: `lib/search.js` (new function after `searchTitles`, exports at 170), `server.js:379-410` (`/api/search`)
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces: `searchNotes(q, transcriptGroups, sessionNotes) -> [{ note, snippet, project, sessionId, lastActivityAt }]`, respecting `project:` and `since:` filters and ignored projects, newest first, capped at `MAX_RESULTS`.
- `/api/search` response gains `notes: [...]` (each with `projectName`).

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="searchNotes" test/pure-logic.test.js` — FAIL, `searchNotes is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/search.js` after `searchTitles`:

```js
// Notes the user attached to sessions (config.json sessionNotes).
function searchNotes(q, transcriptGroups, sessionNotes, now = Date.now()) {
  const { text, project, since } = parseSearchQuery(q, now);
  const needle = text.toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const g of transcriptGroups.values()) {
    if (isIgnored(g.path)) continue;
    if (project && !g.path.toLowerCase().includes(project)) continue;
    for (const m of g.sessions) {
      const note = sessionNotes && sessionNotes[m.sessionId];
      if (!note || !note.toLowerCase().includes(needle)) continue;
      if (since && !(m.lastActivityAt >= since)) continue;
      const i = note.toLowerCase().indexOf(needle);
      const start = Math.max(0, i - 60);
      out.push({
        note,
        snippet: (start > 0 ? '…' : '') + note.slice(start, i + needle.length + 120).replace(/\s+/g, ' '),
        project: g.path,
        sessionId: m.sessionId,
        lastActivityAt: m.lastActivityAt,
      });
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out.slice(0, MAX_RESULTS);
}
```

Export it: `module.exports = { searchHistory, searchTitles, searchNotes, parseSearchQuery, transcriptLineMatch, searchTranscripts };`

In `server.js`: import `searchNotes` on line 12; in the `/api/search` `.then`, after the `titles` line add:

```js
        const notes = searchNotes(q, collector.raw.transcriptGroups, cfg.readConfig().sessionNotes || {});
        for (const r of notes) r.projectName = friendlyName(r.project);
```

and include `notes` in the response object: `{ q, prompts, titles, notes, transcripts, chats }`. In the demo branch's `/api/search` stub add `notes: []`.

- [ ] **Step 4: Run tests, commit**

```bash
npm test
git add lib/search.js server.js test/pure-logic.test.js
git commit -m "Search session notes alongside titles and prompts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: UI

**Files:**
- Modify: `public/index.html` — CSS after `.badge.missing` (line 332); `renameBtn` area (946); `projectCard` (994), `renderPinned` (1023), `digestItem` (1093), `renderDetail` (1372); `transcriptStatus` (1487); `openTranscript` (1547); `runSearch` (1700); the click handler at 2018.

- [ ] **Step 1: CSS**

After line 332 add:

```css
  .note-mark { color: var(--warn); cursor: default; font-size: 12px; flex: none; }
  #note-editor { margin: 10px 0 4px; display: flex; flex-direction: column; gap: 6px; }
  #note-editor textarea {
    width: 100%; min-height: 72px; resize: vertical; box-sizing: border-box;
    font: 12.5px 'JetBrains Mono', ui-monospace, monospace; color: var(--ink);
    background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 8px 10px;
  }
  #note-editor .hint { color: var(--faint); font-size: 11px; }
```

- [ ] **Step 2: Row marker**

After `renameBtn` (line 948) add:

```js
function noteMark(sess) {
  return sess.note ? `<span class="note-mark" title="${esc(sess.note)}">≡</span>` : '';
}
```

Insert `${noteMark(sess)}` immediately after the `s-title` span in `projectCard`; `${noteMark(p)}` after the `s-title` span in `renderPinned`; `${noteMark(it)}` after the `di-title` span in `digestItem`; `${noteMark(s)}` after the `s-title` span in `renderDetail`'s session list.

- [ ] **Step 3: Transcript header button and editor**

In `transcriptStatus`, add a button before the export button:

```js
    ${sid ? `<button class="copy" data-note-toggle title="Attach a note to this session">note${exportableSession.note ? ' ≡' : ''}</button>` : ''}
```

In `openTranscript`, after `exportableSession = { id: sessionId, title: t.title };` change to:

```js
    exportableSession = { id: sessionId, title: t.title, note: t.note || null };
```

Add these functions after `transcriptStatus`:

```js
function openNoteEditor() {
  if ($('#note-editor')) { closeNoteEditor(); return; }
  const ed = document.createElement('div');
  ed.id = 'note-editor';
  ed.innerHTML = `<textarea maxlength="2000" placeholder="A note for future you — what this session was for, what's left, what to remember.">${esc(exportableSession.note || '')}</textarea>
    <span class="hint">saves on blur or ⌘⏎ · Esc cancels · empty removes the note</span>`;
  $('#d-body').prepend(ed);
  const ta = ed.querySelector('textarea');
  ta.focus();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeNoteEditor(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(ta.value); }
  });
  ta.addEventListener('blur', () => { if ($('#note-editor')) saveNote(ta.value); });
}

function closeNoteEditor() {
  const ed = $('#note-editor');
  if (ed) ed.remove();
}

async function saveNote(text) {
  const sid = exportableSession && exportableSession.id;
  if (!sid) return;
  const before = exportableSession.note || '';
  closeNoteEditor();
  if (text.trim() === before) return;
  try {
    const r = await fetch('/api/session-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, note: text }) });
    const out = await r.json();
    if (!out.ok) throw new Error(out.error);
    exportableSession.note = out.note || null;
    transcriptStatus();
    toast(out.note ? 'Note saved' : 'Note removed');
  } catch {
    toast("Couldn't save the note");
  }
}
```

In the click handler that starts at line 2018, add before the `[data-pin]` branch:

```js
  if (e.target.closest('[data-note-toggle]')) { openNoteEditor(); return; }
```

Guard the global Escape handler (line 2080) so it doesn't close the drawer while editing: at the top of that handler add `if (e.key === 'Escape' && $('#note-editor')) return;`.

- [ ] **Step 4: Search results section**

In `runSearch`, after `promptRows`, add:

```js
    const noteRows = (d.notes || []).map((n) => `
      <li>
        <span class="s-title" data-session="${esc(n.sessionId)}" title="${esc(n.note)}"><span class="note-mark">≡</span> ${esc(n.snippet)}</span>
        <span class="s-when">${esc(n.projectName)}</span>
        <span class="s-when">${relTime(n.lastActivityAt)}</span>
      </li>`).join('');
```

and in the `$('#d-body').innerHTML =` assembly insert after the prompts section:

```js
      ((d.notes || []).length ? dSection(`Notes — ${d.notes.length}`, `<ul class="d-sessions">${noteRows}</ul>`) : '') +
```

Update the result count line to add `(d.notes || []).length`.

- [ ] **Step 5: Check in the browser**

Run `CLAUDE_DASH_DEV=1 node server.js`. Open any transcript, click `note`, type text, press ⌘⏎: toast "Note saved", button reads `note ≡`, and after the next state push the session's row shows `≡` with the note as tooltip. Search a word from the note: a "Notes" section appears. Clear the note: marker disappears.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Session notes: edit from the transcript, marker on rows, searchable

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: README

- [ ] **Step 1: Add bullets**

After the "Export" bullet (README line 96):

```
- **Notes** — `note` in the transcript header attaches a free-text note to a session (⌘⏎ saves, empty removes). Rows with a note show `≡`, hover to read it, and notes are searchable from the header box. Stored in `config.json` under `sessionNotes`.
```

Under Settings (after the "Rename any project" bullet, line ~130): no change needed; instead in "Friendly names" add a final sentence after the session-rename paragraph:

```
Notes work the same way: `sessionNotes` in `config.json`, keyed by session id, editable by hand.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: session notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: storage + pure helper (Task 1); endpoint, same-origin, id validation, cap (Tasks 1–2); `note` on cards, pinned, slide-over, transcript (Task 2); editor with blur/⌘⏎/Esc (Task 4); markers with tooltip (Task 4); search with filters (Tasks 3–4); README (Task 5).
- Names used consistently: `sessionNotes`, `applySessionNote`, `setSessionNote`, `searchNotes`, `noteMark`, `openNoteEditor`, `saveNote`, `data-note-toggle`.
