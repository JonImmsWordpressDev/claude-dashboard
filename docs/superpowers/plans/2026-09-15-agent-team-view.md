# Agent Team View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session runs subagents or an agent team, show the agents (name, type, model, colour, active/done) under the session's Mission Control pane and in the transcript viewer header.

**Architecture:** The existing subagent scan in `lib/transcripts.js` also reads each `agent-*.meta.json` once and remembers each transcript's mtime. A new `lib/teams.js` reads `~/.claude/teams/*/config.json` (cached by mtime) and resolves a team name per session. The collector emits an `agents` block per live session; `/api/session` emits the same for any session. Status is derived (`active` within 120 s of the last write, else `done`) so state stays fingerprint-stable.

**Tech Stack:** Node ≥ 18, zero dependencies, `node:test`, vanilla JS in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-09-15-agent-team-view-design.md`

## Global Constraints

- Never write to anything under `~/.claude`. Read only.
- Zero npm dependencies.
- Transcripts are never fully parsed; `.meta.json` files are tiny. They are
  read on every rescan of a changed transcript until one parses successfully
  (metas can land minutes to hours after the `.jsonl`, or never), then never
  re-read.
- State carries only derived, stable values: no raw timestamps for agents.
- Work on branch `feature-batch-2026-09`. Run `npm test` before every commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Source shapes (verified)

- `<projects>/<enc>/<sessionId>/subagents/agent-a<name>-<16 hex>.jsonl` (named)
  or `agent-a<16 hex>.jsonl` (unnamed, verified against real files on disk)
  + sibling `.meta.json` of the same
  base name (note the leading `a` right after `agent-`): `{ agentType,
  description, name, spawnDepth, model, taskKind, teamName, color,
  permissionMode }`. `model` can be `opus[1m]`. On real data, 102 of 296 metas
  land minutes to hours after their `.jsonl`, and 220 of 415 have no `name`
  at all (only `description`) — read the meta on every rescan of a changed
  transcript until it parses, then stop; resolve the display name as `name`
  → `description` → the name parsed from the file → `#<hash prefix>`.
- `~/.claude/teams/<team>/config.json`: `{ name, description?, createdAt, leadAgentId, leadSessionId, members: [{ agentId, name, agentType, model?, cwd }] }`. Team dirs named `session-<8 hex>` are auto teams for one session.

## File map

| File | Change |
|---|---|
| `lib/teams.js` (new) | `readTeams()` (cached), `agentStatus`, `resolveTeam`, `agentColor` (pure). |
| `lib/transcripts.js` | `scanSubagents` reads `.meta.json`, returns `agents: [{ name, type, model, color, team, lastWriteAt }]`; `scanAllTranscripts` sets `meta.agents`. |
| `lib/collector.js` | `agents` on live entries; `findSessionFile` returns `agents`. |
| `server.js` | `/api/session` includes `agents`. |
| `public/index.html` | `agentTree()`; Mission Control block; transcript header list; CSS. |
| `lib/demo.js` | Agents on the busy demo session. |
| `test/pure-logic.test.js` | `agentStatus`, `resolveTeam`, `agentColor`, `parseAgentMeta`. |
| `README.md` | Bullet. |

---

### Task 1: Pure helpers in `lib/teams.js`

**Files:**
- Create: `lib/teams.js`
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces: `agentStatus(lastWriteAt, now, activeMs = 120000) -> 'active'|'done'`.
- Produces: `parseAgentMeta(json, fileName) -> { name, type, model, color, team }` tolerant of missing fields; name falls back to the file name's middle segment.
- Produces: `resolveTeam(agents, teams, sessionId) -> string|null` — first non-empty `team` on an agent, else a team whose `leadSessionId === sessionId`, else `null`. Auto team names `session-xxxxxxxx` resolve to `null` (they carry no information).
- Produces: `agentColor(name) -> string` CSS colour for the known Claude Code colour names, `var(--muted)` otherwise.

- [ ] **Step 1: Write the failing tests**

```js
const { agentStatus, parseAgentMeta, resolveTeam, agentColor } = require('../lib/teams');

test('agentStatus: active within 120s of the last write, else done', () => {
  const now = 1_000_000;
  assert.equal(agentStatus(now - 119_000, now), 'active');
  assert.equal(agentStatus(now - 120_001, now), 'done');
  assert.equal(agentStatus(null, now), 'done');
});

test('parseAgentMeta tolerates missing fields and falls back to the file name', () => {
  assert.deepEqual(
    parseAgentMeta({ name: 'final-review', agentType: 'final-review', model: 'opus[1m]', teamName: 'swps-v2', color: 'blue' }, 'agent-final-review-5c7b.meta.json'),
    { name: 'final-review', type: 'final-review', model: 'opus[1m]', color: 'blue', team: 'swps-v2' }
  );
  assert.deepEqual(parseAgentMeta({}, 'agent-impl-task1-3a97.meta.json'), { name: 'impl-task1', type: null, model: null, color: null, team: null });
  assert.deepEqual(parseAgentMeta(null, 'agent-x-1.meta.json'), { name: 'x', type: null, model: null, color: null, team: null });
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern="agentStatus|parseAgentMeta|resolveTeam|agentColor" test/pure-logic.test.js` — FAIL, `Cannot find module '../lib/teams'`.

- [ ] **Step 3: Create `lib/teams.js`**

```js
'use strict';
// Agent teams and subagent metadata. ~/.claude/teams/<name>/config.json is
// read-only and cached by mtime; the pure helpers are unit-tested.
const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const ACTIVE_MS = 120 * 1000;
const AUTO_TEAM = /^session-[0-9a-f]{8}$/i;

const COLORS = {
  blue: '#4a90e2', green: 'var(--accent)', red: 'var(--bad)', yellow: 'var(--warn)',
  purple: '#a86ee0', cyan: '#2fb8c9', orange: '#e08a2f', pink: '#e06ea8', gray: 'var(--faint)', grey: 'var(--faint)',
};

function agentStatus(lastWriteAt, now = Date.now(), activeMs = ACTIVE_MS) {
  return lastWriteAt && now - lastWriteAt <= activeMs ? 'active' : 'done';
}

// agent-<name>-<hash>.meta.json -> <name>
function nameFromFile(fileName) {
  const m = /^agent-(.+)-[0-9a-f]+\.(?:meta\.json|jsonl)$/i.exec(String(fileName || ''));
  return m ? m[1] : String(fileName || '').replace(/\.(meta\.json|jsonl)$/, '');
}

function parseAgentMeta(json, fileName) {
  const j = json && typeof json === 'object' ? json : {};
  return {
    name: typeof j.name === 'string' && j.name ? j.name : nameFromFile(fileName),
    type: typeof j.agentType === 'string' ? j.agentType : null,
    model: typeof j.model === 'string' ? j.model : null,
    color: typeof j.color === 'string' ? j.color : null,
    team: typeof j.teamName === 'string' && j.teamName ? j.teamName : null,
  };
}

function resolveTeam(agents, teams, sessionId) {
  const real = (t) => (t && !AUTO_TEAM.test(t) ? t : null);
  for (const a of agents || []) if (real(a.team)) return a.team;
  for (const t of teams || []) if (t.leadSessionId === sessionId && real(t.name)) return t.name;
  return null;
}

function agentColor(name) {
  return (name && COLORS[String(name).toLowerCase()]) || 'var(--muted)';
}

// [{ name, leadSessionId, members: [{ name, agentType, model }] }], cached per dir mtime.
const cache = new Map(); // dir -> { mtimeMs, team }
async function readTeams() {
  let dirs;
  try {
    dirs = await fsp.readdir(TEAMS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    const file = path.join(TEAMS_DIR, d, 'config.json');
    try {
      const st = await fsp.stat(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) { out.push(hit.team); continue; }
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const team = {
        name: raw.name || d,
        leadSessionId: raw.leadSessionId || null,
        members: (raw.members || []).map((m) => ({ name: m.name, type: m.agentType || null, model: m.model || null })),
      };
      cache.set(file, { mtimeMs: st.mtimeMs, team });
      out.push(team);
    } catch {
      /* unreadable team: skip */
    }
  }
  return out;
}

module.exports = { agentStatus, parseAgentMeta, resolveTeam, agentColor, readTeams };
```

- [ ] **Step 4: Run tests, commit**

```bash
npm test
git add lib/teams.js test/pure-logic.test.js
git commit -m "Agent team helpers: status, metadata parsing, team resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Subagent metadata in the scan

**Files:**
- Modify: `lib/transcripts.js:262-298` (`scanSubagents`), `lib/transcripts.js:41-45` (`scanAllTranscripts`)

**Interfaces:**
- Produces: `meta.agents: [{ name, type, model, color, team, lastWriteAt }] | null` on each session meta (sorted by name).

- [ ] **Step 1: Read meta files alongside transcripts**

Add `const { parseAgentMeta } = require('./teams');` near the top of `lib/transcripts.js`.

Replace `scanSubagents` with:

```js
async function scanSubagents(dir) {
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const total = {};
  const totalDays = {};
  const agents = [];
  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    count++;
    const abs = path.join(dir, f);
    try {
      const st = await fsp.stat(abs);
      let entry = subCache.get(abs);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        const scan = entry && entry.scan && st.size >= entry.scan.offset
          ? entry.scan
          : { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null };
        await incrementalScan(abs, st.size, scan);
        // Agent metadata is written once at spawn; read it the first time only.
        const agent = entry ? entry.agent : await readAgentMeta(abs.replace(/\.jsonl$/, '.meta.json'), f);
        entry = { mtimeMs: st.mtimeMs, size: st.size, scan, agent };
        subCache.set(abs, entry);
      }
      mergeUsage(total, entry.scan.usage);
      mergeDays(totalDays, entry.scan.days);
      agents.push({ ...entry.agent, lastWriteAt: entry.mtimeMs });
    } catch {
      /* skip */
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return count ? { usage: total, days: totalDays, count, agents } : null;
}

async function readAgentMeta(metaPath, jsonlName) {
  try {
    return parseAgentMeta(JSON.parse(await fsp.readFile(metaPath, 'utf8')), jsonlName);
  } catch {
    return parseAgentMeta(null, jsonlName);
  }
}
```

(If Task 2 of the session-changes plan has already added `changes` to this function's return, keep that field too.)

In `scanAllTranscripts`, after `meta.subagentCount = sub ? sub.count : 0;` add:

```js
          meta.agents = sub && sub.agents.length ? sub.agents : null;
```

- [ ] **Step 2: Smoke-check**

```bash
node -e "
require('./lib/transcripts').scanAllTranscripts().then((s) => {
  const m = s.filter((x) => x.agents).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  console.log(m ? m.agents.slice(0, 4) : 'no sessions with agents');
});
"
```

Expected: an array of `{ name, type, model, color, team, lastWriteAt }`.

- [ ] **Step 3: Run tests, commit**

```bash
npm test
git add lib/transcripts.js
git commit -m "Read subagent metadata alongside their transcripts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Collector state and `/api/session`

**Files:**
- Modify: `lib/collector.js` (imports; `refreshScan` 129–143; per-session maps 239–249; live entry 284–303; `findSessionFile` 512–521), `server.js:370`

**Interfaces:**
- Produces: live entries gain `agents: { team: string|null, list: [{ name, type, model, color, status }] } | null`; `findSessionFile` returns `agents` with every status `'done'`; `/api/session` includes `agents`.

- [ ] **Step 1: Collector**

Import: `const { readTeams, agentStatus, resolveTeam } = require('./teams');`

In `refreshScan`, after `this.raw.history = await refreshHistory();` add `this.raw.teams = await readTeams();`. Initialise `teams: []` in `this.raw` in the constructor.

Add a method after `reasonFor` (or after `titleOf` if the waiting-reason plan has not run):

```js
  // Subagents/team for a session, statuses derived so state stays stable.
  agentsFor(m, live) {
    if (!m || !m.agents) return null;
    const now = Date.now();
    return {
      team: resolveTeam(m.agents, this.raw.teams || [], m.sessionId),
      list: m.agents.map((a) => ({
        name: a.name, type: a.type, model: a.model, color: a.color,
        status: live ? agentStatus(a.lastWriteAt, now) : 'done',
      })),
    };
  }
```

In `assemble()`, beside `subsBySession` add `const metaBySession = new Map();` and set `metaBySession.set(m.sessionId, m);` in the same loop. In the live entry add after `subagents: …`:

```js
        agents: this.agentsFor(metaBySession.get(s.sessionId), true),
```

In `findSessionFile`, add `agents: this.agentsFor(m, this.raw.live.some((s) => s.sessionId === sessionId))` to the returned object.

- [ ] **Step 2: Server**

In the `/api/session` response (line 370) add `agents: found.agents || null,`.

- [ ] **Step 3: Verify**

Run `node server.js` and `curl -s http://127.0.0.1:4517/api/state | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const l of s.liveSessions)console.log(l.projectName, JSON.stringify(l.agents))"`. Expected: `null` or a `{team, list}` block per live session. Then fetch `/api/session?id=<a session with subagents>` and confirm `agents.list` with `status: 'done'`.

- [ ] **Step 4: Run tests, commit**

```bash
npm test
git add lib/collector.js server.js
git commit -m "Agents and team per session in state and the session endpoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: UI and demo

**Files:**
- Modify: `public/index.html` — CSS after `.mc-pane-body .t-turn` (line 598); `mcSync` (pane markup at 1643 and per-tick update); `openTranscript` header; `lib/demo.js` S2 live entry and `blogSession`.

- [ ] **Step 1: CSS**

```css
  .agents { padding: 4px 12px 6px; border-bottom: 1px solid var(--line); font-size: 11.5px; flex: none; }
  .agents .team { color: var(--faint); text-transform: uppercase; letter-spacing: 0.08em; font-size: 10.5px; margin-bottom: 2px; }
  .agents .agent { display: flex; align-items: center; gap: 7px; line-height: 1.6; }
  .agents .swatch { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .agents .aname { color: var(--ink); }
  .agents .atype { color: var(--faint); }
  .agents .astatus { margin-left: auto; color: var(--faint); }
  .agents .astatus.active { color: var(--accent); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .agents summary { cursor: pointer; list-style: none; color: var(--faint); font-size: 10.5px; }
  #drawer .agents { padding: 6px 0 4px; border-bottom: none; }
```

- [ ] **Step 2: Renderer**

Add after `mcPaneHead`:

```js
const AGENT_COLORS = { blue: '#4a90e2', green: 'var(--accent)', red: 'var(--bad)', yellow: 'var(--warn)', purple: '#a86ee0', cyan: '#2fb8c9', orange: '#e08a2f', pink: '#e06ea8', gray: 'var(--faint)', grey: 'var(--faint)' };

function agentTree(agents, { collapsible = false, key = '' } = {}) {
  if (!agents || !agents.list || !agents.list.length) return '';
  const rows = agents.list.map((a) => `<div class="agent">
      <span class="swatch" style="background:${AGENT_COLORS[(a.color || '').toLowerCase()] || 'var(--muted)'}"></span>
      <span class="aname">${esc(a.name)}</span>
      ${a.type && a.type !== a.name ? `<span class="atype">${esc(a.type)}</span>` : ''}
      ${a.model ? modelChip(a.model) : ''}
      <span class="astatus ${a.status}" title="${a.status === 'active' ? 'wrote to its transcript in the last 2 minutes' : 'finished'}">${a.status === 'active' ? '●' : '✓'}</span>
    </div>`).join('');
  const team = agents.team ? `<div class="team">team · ${esc(agents.team)}</div>` : '';
  if (!collapsible) return `<div class="agents">${team}${rows}</div>`;
  const open = localStorage.getItem(`agentsOpen:${key}`) !== '0';
  return `<details class="agents" data-agents-key="${esc(key)}" ${open ? 'open' : ''}><summary>${agents.list.length} agent${agents.list.length === 1 ? '' : 's'}${agents.team ? ` · ${esc(agents.team)}` : ''}</summary>${rows}</details>`;
}
```

- [ ] **Step 3: Mission Control**

In `mcSync`, change the new-pane markup to include an agents slot after the task line:

```js
      el.innerHTML = '<div class="mc-pane-head"></div><div class="mc-pane-task" hidden></div><div class="mc-agents"></div><div class="mc-pane-body"><div class="d-empty">Loading…</div></div>';
```

and after the task update add:

```js
    const agentsEl = pane.el.querySelector('.mc-agents');
    const tree = agentTree(s.agents, { collapsible: true, key: s.sessionId });
    if (agentsEl.innerHTML !== tree && !agentsEl.querySelector('details[open]') === !tree.includes(' open')) patch(agentsEl, tree);
    else if (!tree) patch(agentsEl, '');
```

Simplify that to a plain `patch(agentsEl, tree)` if the toggle-state check proves fiddly; the `toggle` listener below re-stores the state so a re-render restores it. Add once, after `$('#mc-close').addEventListener(...)`:

```js
$('#mc-grid').addEventListener('toggle', (e) => {
  const d = e.target.closest('details[data-agents-key]');
  if (d) localStorage.setItem(`agentsOpen:${d.dataset.agentsKey}`, d.open ? '1' : '0');
}, true);
```

- [ ] **Step 4: Transcript viewer**

In `openTranscript`, after `parts.push(transcriptHtml(t.events));` insert before it:

```js
    if (t.agents) parts.unshift(agentTree(t.agents));
```

(i.e. the static tree renders above the first turn.)

- [ ] **Step 5: Demo**

In `lib/demo.js`, on the S2 live entry add:

```js
        agents: { team: 'block-migration', list: [
          { name: 'inventory', type: 'explore', model: 'claude-haiku-4-5', color: 'cyan', status: 'done' },
          { name: 'converter', type: 'general-purpose', model: 'claude-fable-5', color: 'blue', status: 'active' },
          { name: 'reviewer', type: 'code-review', model: 'claude-opus-5', color: 'purple', status: 'active' },
        ] },
```

Add `agents: null,` to the other live entries. In `blogSession` return, add the same `agents` object (statuses `done`) so the transcript header shows it.

- [ ] **Step 6: Check**

Demo mode → Mission Control: the Blog Engine pane shows "3 agents · block-migration" with a pulsing `●` on two rows; collapse it, close and reopen Mission Control, it stays collapsed. Open the Blog Engine transcript: the static list appears above the first turn.

- [ ] **Step 7: Commit**

```bash
git add public/index.html lib/demo.js
git commit -m "Agent team tree in Mission Control panes and the transcript viewer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: README

- [ ] **Step 1:** After the Mission Control bullet (README line 79) add:

```
- **Agents** — a session running subagents or an agent team shows them under its Mission Control pane: name, type, model, and a pulsing `●` while an agent is still writing (`✓` when done), with the team name when there is one. Finished sessions list them at the top of the transcript.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: agent team view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: `.meta.json` read once (Task 2); status derived, no timestamps in state (Task 3); team from meta or `leadSessionId` (Task 1); Mission Control block with colours, pulse, collapsible with `localStorage` (Task 4); transcript header static list (Task 4); `⑂ n` chip untouched; demo (Task 4); tests (Task 1); README (Task 5).
- Names used consistently: `agentStatus`, `parseAgentMeta`, `resolveTeam`, `agentColor` (server) / `AGENT_COLORS` (client), `readTeams`, `agentsFor`, `agentTree`.
