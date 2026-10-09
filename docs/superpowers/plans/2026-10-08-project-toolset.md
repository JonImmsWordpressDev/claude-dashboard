# Project Toolset (Batch B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The project slide-over shows the effective toolset for that project (plugins, agents, skills, MCP servers), resolved with Claude Code's documented precedence rules, each row with its on/off state, where it came from, which scope decided it, a copyable recipe to flip it, and a button that reveals the settings file. Read-only: nothing here writes Claude configuration.

**Architecture:** A new `lib/toolset.js` holds pure resolvers (`resolvePlugins`, `resolveAgents`, `resolveSkills`, `resolveMcp`, `auditToolset`, `recipeFor`) plus a `readToolset(root, inventory)` reader that gathers the four settings scopes and the agent/skill candidates from the project, the user dir, and installed plugins. Shared markdown-directory helpers move out of `lib/detail.js` into `lib/mdfiles.js`. `GET /api/project` gains a `toolset` field; a new same-origin `POST /api/reveal-file` reveals one of three fixed files inside a collector-known project via `lib/opener.js`. The UI adds one "Toolset" section to the drawer.

**Tech Stack:** Node ≥ 18, zero npm dependencies, `node:test` + `node:assert`, single-file UI in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-10-08-cost-toolset-context-design.md`, section B (B1 through B4 and the stated scope cut). Batch A shipped on this branch; batch C has its own plan.

## Global Constraints

- Never write to anything under `~/.claude`, to `~/.claude.json`, or to any project's `.claude/` directory. This batch only reads them. The only "action" is revealing a file in the OS file manager.
- No new network calls. Zero npm dependencies.
- Every endpoint that executes a shell command validates its inputs against collector-known state: `path` must equal one of `collector.projectPaths()` (case-insensitive, as `/api/project` does); `which` must be one of three literal keys; the server composes the absolute path itself. Same-origin enforced on the POST.
- Precedence, highest first: managed, local (`.claude/settings.local.json`), project (`.claude/settings.json`), user (`~/.claude/settings.json`). A key set at a higher level overrides the same key lower down. Deny wins over allow.
- Agent name collapse: project `.claude/agents/` > user `~/.claude/agents/` > plugin `agents/`. Deny rules are `Agent(name)` or the legacy alias `Task(name)`; a plugin agent also matches the namespaced form `pluginName:agentName`, where `pluginName` is the plugin id before `@`.
- Skills: `skillOverrides[name]` ∈ `on | name-only | user-invocable-only | off` (highest scope wins); plugin skills ignore `skillOverrides` and follow the plugin's enabled state. `Skill(name)` deny rules apply like agent denies.
- MCP: per-project on/off lives only in `~/.claude.json` (`disabledIn` from `lib/inventory.js`); the recipe for an MCP row is a sentence, not JSON.
- Recipes target `.claude/settings.local.json`; the toast says "merge into", never "replace".
- Every interpolated text value in new UI markup goes through `esc()`.
- New logic in `lib/` is pure and exported with tests in `test/pure-logic.test.js` wherever it can be; readers take injected listing functions so they are testable without touching the real `~/.claude`.
- Commit after each task; `npm test` green before every commit. Attribution trailer may name the model that actually wrote the commit.

## Review Focus

1. A settings file that exists but is invalid JSON, or a `permissions.deny` that is not an array, must not crash the drawer; the scope is treated as empty and the audit lists the unreadable file. (Task 5 tests `readScopes` with an injected reader that throws; Task 3 tests `parseDenyRules` with non-array input.)
2. Deny rules written with spaces or quotes, like `Agent( reviewer )` or `Task("reviewer")`, must still match. (Task 3 tests `parseDenyRules`.)
3. A plugin whose `installPath` is missing on disk, or has no `agents/`/`skills/` directory, must contribute no rows and no error. (Task 5 tests `collectCandidates` with a lister that returns `[]` and one that throws.)
4. The same agent name defined in the project and in a plugin: the project copy wins and the plugin copy is listed as shadowed; a deny on that name disables the winner and must not silently "fall back" to the loser. (Task 3 tests `resolveAgents`.)
5. `POST /api/reveal-file` with an unknown `path`, a `which` outside the allowlist, or a file that does not exist must return 404/400 and execute nothing. (Task 6 tests `revealTarget`; the endpoint is curl-checked in Task 6 Step 6.)

---

### Task 1: Shared markdown-directory helpers (`lib/mdfiles.js`)

**Files:**
- Create: `lib/mdfiles.js`
- Modify: `lib/detail.js:1-45` (remove the three local helpers, import them)
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces:
  - `readCapped(abs) -> Promise<{ content, size, mtimeMs } | null>` (64 KB cap; unchanged behaviour, moved)
  - `listMd(dir) -> Promise<string[]>` (sorted `.md` names; `[]` when the dir is missing; moved)
  - `frontmatterDescription(content) -> string | null` (moved)
  - `listAgents(dir) -> Promise<[{ name, description }]>` (one per `.md` file, name without extension)
  - `listSkills(dir) -> Promise<[{ name, description }]>` (one per subdirectory containing `SKILL.md`)
  - Both listers return `[]` for a missing or unreadable directory and never throw.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok"`
Expected: `Cannot find module '../lib/mdfiles'`.

- [ ] **Step 3: Create `lib/mdfiles.js`**

```js
'use strict';
// Small readers for the markdown-file conventions Claude Code uses:
// agents are `<dir>/<name>.md`, skills are `<dir>/<name>/SKILL.md`, both
// with YAML frontmatter carrying a `description:`. Everything here is
// read-only and tolerant: a missing or unreadable directory lists as [].
const fsp = require('fs/promises');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024; // per-file cap for returned content

async function readCapped(abs) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return null;
    const fh = await fsp.open(abs, 'r');
    try {
      const len = Math.min(st.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      let content = buf.toString('utf8');
      if (st.size > MAX_FILE_BYTES) content += `\n\n… truncated (${st.size} bytes total)`;
      return { content, size: st.size, mtimeMs: st.mtimeMs };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function listMd(dir) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

// First `description:` line of YAML frontmatter, if any.
function frontmatterDescription(content) {
  if (!content || !content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const m = content.slice(0, end).match(/^description:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 300) : null;
}

// Agents: one `.md` per agent, name = filename without extension.
async function listAgents(dir) {
  const out = [];
  for (const name of await listMd(dir)) {
    const file = await readCapped(path.join(dir, name));
    out.push({ name: name.replace(/\.md$/, ''), description: file ? frontmatterDescription(file.content) : null });
  }
  return out;
}

// Skills: one directory per skill containing SKILL.md.
async function listSkills(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = await readCapped(path.join(dir, entry.name, 'SKILL.md'));
    if (!skillMd) continue;
    out.push({ name: entry.name, description: frontmatterDescription(skillMd.content) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = { readCapped, listMd, frontmatterDescription, listAgents, listSkills, MAX_FILE_BYTES };
```

- [ ] **Step 4: Make `lib/detail.js` use it**

Delete `MAX_FILE_BYTES`, `readCapped`, `listMd`, and `frontmatterDescription` from `lib/detail.js` (lines 9-45 in the current file) and add after the existing requires:

```js
const { readCapped, listMd, frontmatterDescription } = require('./mdfiles');
```

`collectCapabilities`, `collectSettings`, `collectMemory`, and `projectDetail` are unchanged and keep working because the three names now resolve to the imported functions.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

Then confirm the drawer endpoint still works: `CLAUDE_DASH_PORT=4599 node server.js &` (note the PID), `curl -s "http://127.0.0.1:4599/api/project?path=<a known project path, URL-encoded>" | head -c 300`, then `kill <pid>`. Expected: JSON starting with `{"path":…`.

- [ ] **Step 6: Commit**

```bash
git add lib/mdfiles.js lib/detail.js test/pure-logic.test.js
git commit -m "Lift markdown-directory helpers into lib/mdfiles.js; add listAgents/listSkills"
```

---

### Task 2: Carry `installPath` on inventory plugin rows

**Files:**
- Modify: `lib/inventory.js:15-37`
- Test: `test/pure-logic.test.js` (the existing `mergePlugins` tests at ~line 1231)

**Interfaces:**
- Produces: each row from `mergePlugins` gains `installPath: string | null` (from `installed_plugins.json`'s per-plugin `installPath`; null when not installed or absent).

- [ ] **Step 1: Extend the existing test**

In the test `mergePlugins joins installs with enabled state and marketplace freshness`, find the `installed` fixture object it builds and add `installPath: '/plugins/cache/x/a/1.0.0'` to the first plugin's entry object (the one inside the array), then add to the assertions:

```js
  assert.equal(rows.find((r) => r.installed).installPath, '/plugins/cache/x/a/1.0.0');
  assert.equal(rows.find((r) => !r.installed).installPath, null);
```

(If the fixture has no not-installed row, add one to `enabled` only, e.g. `'ghost@x': true`, so the second assertion has a target.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern="mergePlugins joins" test/pure-logic.test.js 2>&1 | grep -E "^not ok|installPath"`
Expected: a failing `undefined !== '/plugins/cache/x/a/1.0.0'`.

- [ ] **Step 3: Implement**

In `lib/inventory.js` `mergePlugins`, inside `rows.push({ … })`, after `version: inst ? String(inst.version || '') : null,` add:

```js
      installPath: inst && typeof inst.installPath === 'string' ? inst.installPath : null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/inventory.js test/pure-logic.test.js
git commit -m "Inventory: plugin rows carry installPath"
```

---

### Task 3: Pure resolvers — deny rules, plugins, agents, skills

**Files:**
- Create: `lib/toolset.js`
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces (all pure, exported):
  - `SCOPE_ORDER = ['managed', 'local', 'project', 'user']` (highest first)
  - `parseDenyRules(denyList) -> { agents: Set<string>, skills: Set<string> }` — accepts non-arrays (→ empty sets); entries `Agent(x)`, `Task(x)`, `Skill(x)` with optional spaces/quotes around `x`.
  - `resolvePlugins(pluginRows, scopes) -> Row[]` — `pluginRows` from `inventory.plugins`; `scopes` is `{ managed, local, project, user }`, each a parsed settings object or null.
  - `resolveAgents(candidates, scopes) -> Row[]` — `candidates: [{ name, source: 'project'|'user'|'plugin', pluginId, description }]`.
  - `resolveSkills(candidates, scopes, pluginRows) -> Row[]`.
  - `Row = { name, kind: 'plugin'|'agent'|'skill', enabled, mode?, source, pluginId, decidedBy, shadowed: string[], description, installed?, stale?, installPath? }` (recipes are attached in Task 4).
  - `pluginShortName(pluginId) -> string` (`'ecc@claude-plugins-official'` → `'ecc'`).

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok" | head -3`
Expected: `Cannot find module '../lib/toolset'`.

- [ ] **Step 3: Create `lib/toolset.js` with the resolvers**

```js
'use strict';
// Effective toolset for one project: which plugins, agents, skills, and
// MCP servers Claude Code would use there, resolved with its documented
// precedence. Read-only. The pure resolvers take already-parsed settings
// objects so they can be tested without a filesystem.

// Settings scopes, highest precedence first.
const SCOPE_ORDER = ['managed', 'local', 'project', 'user'];

function pluginShortName(pluginId) {
  const at = String(pluginId || '').lastIndexOf('@');
  return at > 0 ? pluginId.slice(0, at) : String(pluginId || '');
}

// permissions.deny entries that name agents or skills:
// Agent(name), the legacy Task(name) alias, and Skill(name). Spaces and
// quotes around the name are tolerated; anything else is ignored.
function parseDenyRules(denyList) {
  const agents = new Set();
  const skills = new Set();
  if (!Array.isArray(denyList)) return { agents, skills };
  for (const entry of denyList) {
    if (typeof entry !== 'string') continue;
    const m = entry.match(/^\s*(Agent|Task|Skill)\(\s*["']?([^"')]+?)["']?\s*\)\s*$/);
    if (!m) continue;
    (m[1] === 'Skill' ? skills : agents).add(m[2].trim());
  }
  return { agents, skills };
}

// Highest scope whose deny list names any of `names`.
function denyScope(scopes, names, kind) {
  for (const s of SCOPE_ORDER) {
    const obj = scopes && scopes[s];
    if (!obj || !obj.permissions) continue;
    const rules = parseDenyRules(obj.permissions.deny)[kind];
    if (names.some((n) => rules.has(n))) return s;
  }
  return null;
}

function sortRows(rows) {
  return rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

// pluginRows: lib/inventory.js plugin rows. A plugin is decided by the
// highest scope whose enabledPlugins mentions its id; an installed plugin
// no scope mentions is off by default. Ids mentioned but not installed
// are listed too, so the audit can flag them.
function resolvePlugins(pluginRows, scopes) {
  const byId = new Map((pluginRows || []).map((r) => [r.id, r]));
  const ids = new Set(byId.keys());
  for (const s of SCOPE_ORDER) {
    const obj = scopes && scopes[s];
    for (const id of Object.keys((obj && obj.enabledPlugins) || {})) ids.add(id);
  }
  const rows = [];
  for (const id of ids) {
    const inv = byId.get(id) || null;
    let enabled = false;
    let decidedBy = 'default';
    for (const s of SCOPE_ORDER) {
      const map = scopes && scopes[s] && scopes[s].enabledPlugins;
      if (map && Object.prototype.hasOwnProperty.call(map, id)) {
        enabled = map[id] === true;
        decidedBy = s;
        break;
      }
    }
    rows.push({
      name: inv ? inv.name : pluginShortName(id),
      kind: 'plugin',
      enabled,
      source: 'user',
      pluginId: id,
      decidedBy,
      shadowed: [],
      description: null,
      installed: !!(inv && inv.installed),
      stale: !!(inv && inv.stale),
      installPath: inv ? inv.installPath || null : null,
    });
  }
  return sortRows(rows);
}

const AGENT_PRECEDENCE = { project: 0, user: 1, plugin: 2 };

function sourceLabel(c) {
  return c.source === 'plugin' ? `plugin:${pluginShortName(c.pluginId)}` : c.source;
}

// candidates: { name, source: 'project'|'user'|'plugin', pluginId, description }.
// Same names collapse project > user > plugin; losers are listed as
// shadowed on the winner. Deny rules then disable the winner.
function resolveAgents(candidates, scopes) {
  const groups = new Map();
  for (const c of candidates || []) {
    if (!groups.has(c.name)) groups.set(c.name, []);
    groups.get(c.name).push(c);
  }
  const rows = [];
  for (const [name, group] of groups) {
    group.sort((a, b) => AGENT_PRECEDENCE[a.source] - AGENT_PRECEDENCE[b.source]);
    const win = group[0];
    const names = win.source === 'plugin' ? [name, `${pluginShortName(win.pluginId)}:${name}`] : [name];
    const denied = denyScope(scopes, names, 'agents');
    rows.push({
      name,
      kind: 'agent',
      enabled: !denied,
      source: win.source,
      pluginId: win.pluginId || null,
      decidedBy: denied || 'default',
      shadowed: group.slice(1).map(sourceLabel),
      description: win.description || null,
    });
  }
  return sortRows(rows);
}

const SKILL_MODES = new Set(['on', 'name-only', 'user-invocable-only', 'off']);

// Project and user skills obey skillOverrides (highest scope wins) and
// Skill(name) deny rules; plugin skills follow their plugin's state.
function resolveSkills(candidates, scopes, pluginRows) {
  const pluginOn = new Map((pluginRows || []).map((r) => [r.pluginId, !!r.enabled]));
  const rows = [];
  for (const c of candidates || []) {
    if (c.source === 'plugin') {
      rows.push({
        name: c.name, kind: 'skill', enabled: pluginOn.get(c.pluginId) === true, mode: null,
        source: 'plugin', pluginId: c.pluginId, decidedBy: 'plugin', shadowed: [], description: c.description || null,
      });
      continue;
    }
    let enabled = true;
    let mode = null;
    let decidedBy = 'default';
    for (const s of SCOPE_ORDER) {
      const ov = scopes && scopes[s] && scopes[s].skillOverrides;
      if (ov && SKILL_MODES.has(ov[c.name])) {
        mode = ov[c.name];
        enabled = mode !== 'off';
        decidedBy = s;
        break;
      }
    }
    const denied = denyScope(scopes, [c.name], 'skills');
    if (denied) {
      enabled = false;
      decidedBy = denied;
    }
    rows.push({
      name: c.name, kind: 'skill', enabled, mode, source: c.source, pluginId: null,
      decidedBy, shadowed: [], description: c.description || null,
    });
  }
  return sortRows(rows);
}

module.exports = { SCOPE_ORDER, pluginShortName, parseDenyRules, resolvePlugins, resolveAgents, resolveSkills };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/toolset.js test/pure-logic.test.js
git commit -m "Toolset: pure resolvers for deny rules, plugins, agents, skills"
```

---

### Task 4: Pure resolvers — MCP rows, audit findings, recipes

**Files:**
- Modify: `lib/toolset.js`
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces (pure, exported):
  - `resolveMcp(mcpRows, root) -> Row[]` — `mcpRows` from `inventory.mcp`; rows with `scope === 'global'` or `projects` containing `root` (case-insensitive compare); `enabled = !disabledIn.includes(root)`; `source` is the inventory `scope`; `decidedBy` is `'claude.json'` when disabled else `'default'`; carries `needsAuth`.
  - `auditToolset(ts, unreadable = []) -> [{ level: 'warn'|'info', text }]` where `ts = { plugins, agents, skills, mcp, denyUnmatched: { agents: [], skills: [] } }`.
  - `recipeFor(row, root) -> { label, text, target }` — `target` is the file (or the phrase `a Claude session in this project`) the toast names.
  - `attachRecipes(toolset, root)` — sets `recipe` on every row and returns the same object.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
  const mcp = recipeFor({ kind: 'mcp', name: 'gh', source: 'global', enabled: true }, root);
  assert.ok(mcp.text.startsWith('Run /mcp inside a Claude session in this project and toggle gh'), mcp.text);
  assert.equal(mcp.target, 'a Claude session in this project');
  const mj = recipeFor({ kind: 'mcp', name: 'shared', source: 'mcp.json', enabled: true }, root);
  assert.deepEqual(JSON.parse(mj.text), { disabledMcpjsonServers: ['shared'] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok" | head -3`
Expected: `resolveMcp is not a function`.

- [ ] **Step 3: Add to `lib/toolset.js`** (before `module.exports`)

```js
function samePath(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// inventory.mcp rows filtered to what this project sees: global servers
// plus the ones defined for this project. Per-project on/off is what
// Claude Code stored in ~/.claude.json (disabledIn).
function resolveMcp(mcpRows, root) {
  const rows = [];
  for (const m of mcpRows || []) {
    const used = m.scope === 'global' || (m.projects || []).some((p) => samePath(p, root));
    if (!used) continue;
    const off = (m.disabledIn || []).some((p) => samePath(p, root));
    rows.push({
      name: m.name,
      kind: 'mcp',
      enabled: !off,
      source: m.scope,
      pluginId: null,
      decidedBy: off ? 'claude.json' : 'default',
      shadowed: [],
      description: m.type ? `${m.type}${m.url ? ` · ${m.url}` : ''}` : null,
      needsAuth: !!m.needsAuth,
    });
  }
  return sortRows(rows);
}

// Things worth a glance. `unreadable` lists settings files that exist
// but did not parse. denyUnmatched: deny-rule names no candidate defines.
function auditToolset(ts, unreadable = []) {
  const out = [];
  for (const f of unreadable) out.push({ level: 'warn', text: `${f} is unreadable (invalid JSON?) — its settings were ignored` });
  for (const p of ts.plugins || []) {
    if (p.enabled && !p.installed) out.push({ level: 'warn', text: `plugin ${p.name} is enabled by ${p.decidedBy} settings but not installed` });
    if (p.enabled && p.stale) out.push({ level: 'warn', text: `plugin ${p.name} is stale — its marketplace was refreshed after it was last updated` });
  }
  for (const m of ts.mcp || []) {
    if (m.enabled && m.needsAuth) out.push({ level: 'warn', text: `MCP server ${m.name} needs auth` });
  }
  const dm = ts.denyUnmatched || { agents: [], skills: [] };
  for (const n of dm.agents) out.push({ level: 'warn', text: `a deny rule names agent ${n}, which no project, user, or plugin agent defines` });
  for (const n of dm.skills) out.push({ level: 'warn', text: `a deny rule names skill ${n}, which no project, user, or plugin skill defines` });
  for (const a of ts.agents || []) {
    if (a.shadowed && a.shadowed.length) out.push({ level: 'info', text: `agent ${a.name} (${a.source}) shadows ${a.shadowed.join(', ')}` });
  }
  return out;
}

const LOCAL = '.claude/settings.local.json';

function snippet(obj) {
  return JSON.stringify(obj, null, 2);
}

// What to copy to flip a row, aimed at the project's settings.local.json
// (highest-precedence file the user owns). MCP state lives in
// ~/.claude.json, which we never write and do not teach people to
// hand-edit, so that recipe is a sentence.
function recipeFor(row, root) {
  const r = row;
  if (r.kind === 'plugin' || (r.kind === 'skill' && r.source === 'plugin')) {
    return {
      label: r.enabled ? `disable plugin ${pluginShortName(r.pluginId)}` : `enable plugin ${pluginShortName(r.pluginId)}`,
      text: snippet({ enabledPlugins: { [r.pluginId]: !r.enabled } }),
      target: LOCAL,
    };
  }
  if (r.kind === 'agent') {
    const ruleName = r.source === 'plugin' ? `${pluginShortName(r.pluginId)}:${r.name}` : r.name;
    if (r.enabled) {
      return { label: `disable agent ${r.name}`, text: snippet({ permissions: { deny: [`Agent(${ruleName})`] } }), target: LOCAL };
    }
    const where = r.decidedBy === 'local' || r.decidedBy === 'default' ? LOCAL : `${r.decidedBy} settings`;
    return {
      label: `enable agent ${r.name}`,
      text: `Remove the "Agent(${ruleName})" (or "Task(${ruleName})") entry from permissions.deny in ${where}.`,
      target: LOCAL,
    };
  }
  if (r.kind === 'skill') {
    return {
      label: r.enabled ? `turn off skill ${r.name}` : `turn on skill ${r.name}`,
      text: snippet({ skillOverrides: { [r.name]: r.enabled ? 'off' : 'on' } }),
      target: LOCAL,
    };
  }
  // mcp
  if (r.source === 'mcp.json' && r.enabled) {
    return { label: `veto ${r.name} for this project`, text: snippet({ disabledMcpjsonServers: [r.name] }), target: LOCAL };
  }
  return {
    label: r.enabled ? `disable MCP server ${r.name}` : `enable MCP server ${r.name}`,
    text: `Run /mcp inside a Claude session in this project and toggle ${r.name}.`,
    target: 'a Claude session in this project',
  };
}

function attachRecipes(ts, root) {
  for (const kind of ['plugins', 'agents', 'skills', 'mcp']) {
    for (const row of ts[kind] || []) row.recipe = recipeFor(row, root);
  }
  return ts;
}
```

Update the export line:

```js
module.exports = {
  SCOPE_ORDER, pluginShortName, parseDenyRules, resolvePlugins, resolveAgents, resolveSkills,
  resolveMcp, auditToolset, recipeFor, attachRecipes,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/toolset.js test/pure-logic.test.js
git commit -m "Toolset: MCP rows, audit findings, copyable recipes"
```

---

### Task 5: Readers, `readToolset`, and the `/api/project` wiring

**Files:**
- Modify: `lib/toolset.js`
- Modify: `server.js:231-258` (real `/api/project`), `server.js:121-126` (demo branch), and its `require('./lib/demo')` line
- Modify: `lib/demo.js` (add `demoToolset`)
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `listAgents`/`listSkills`, Task 2 `installPath`, Tasks 3–4 resolvers; `managedSettingsPath` and `CLAUDE_DIR` from `lib/paths.js`; `readInventory` from `lib/inventory.js` (already required in `server.js`).
- Produces:
  - `readJsonStatus(abs) -> Promise<'missing' | 'invalid' | object>`
  - `readScopes(root, readJsonFn = readJsonStatus) -> Promise<{ scopes: { managed, local, project, user }, files: { managed, local, project, user }, unreadable: string[] }>`
  - `collectCandidates(root, pluginRows, listers = { listAgents, listSkills }) -> Promise<{ agents, skills }>` — only enabled, installed plugins with an `installPath` contribute.
  - `denyUnmatched(scopes, agentRows, skillRows) -> { agents: string[], skills: string[] }`
  - `readToolset(root, inventory) -> Promise<{ plugins, agents, skills, mcp, audit, files }>` with recipes attached.
  - `GET /api/project` returns `toolset`; demo returns `demoToolset()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok" | head -3`
Expected: `readScopes is not a function`.

- [ ] **Step 3: Add the readers to `lib/toolset.js`**

At the top of the file, after `'use strict';` and its comment, add:

```js
const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR, managedSettingsPath } = require('./paths');
const { listAgents, listSkills } = require('./mdfiles');
```

Before `module.exports`, add:

```js
// 'missing' | 'invalid' | parsed object. Distinguishing the two failure
// modes lets the audit say "unreadable" instead of silently ignoring a
// file an admin or the user clearly meant to be read.
async function readJsonStatus(abs) {
  let raw;
  try {
    raw = await fsp.readFile(abs, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : 'invalid';
  } catch {
    return 'invalid';
  }
}

function scopeFiles(root) {
  return {
    managed: managedSettingsPath(),
    local: path.join(root, '.claude', 'settings.local.json'),
    project: path.join(root, '.claude', 'settings.json'),
    user: path.join(CLAUDE_DIR, 'settings.json'),
  };
}

const SCOPE_LABELS = { managed: 'managed-settings.json', local: '.claude/settings.local.json', project: '.claude/settings.json', user: '~/.claude/settings.json' };

async function readScopes(root, readJsonFn = readJsonStatus) {
  const files = scopeFiles(root);
  const scopes = { managed: null, local: null, project: null, user: null };
  const present = { managed: false, local: false, project: false, user: false };
  const unreadable = [];
  for (const s of SCOPE_ORDER) {
    let v = 'missing';
    try {
      v = await readJsonFn(files[s]);
    } catch {
      v = 'missing';
    }
    if (v === 'missing') continue;
    present[s] = true;
    if (v === 'invalid') unreadable.push(SCOPE_LABELS[s]);
    else scopes[s] = v;
  }
  return { scopes, files: present, unreadable };
}

// Agent and skill candidates from the project, the user dir, and every
// enabled, installed plugin with a known install path. A lister that
// throws contributes nothing from that directory.
async function collectCandidates(root, pluginRows, listers = { listAgents, listSkills }) {
  const safe = async (fn, dir) => {
    try {
      return await fn(dir);
    } catch {
      return [];
    }
  };
  const agents = [];
  const skills = [];
  for (const [source, base] of [['project', path.join(root, '.claude')], ['user', CLAUDE_DIR]]) {
    for (const a of await safe(listers.listAgents, path.join(base, 'agents'))) agents.push({ ...a, source, pluginId: null });
    for (const s of await safe(listers.listSkills, path.join(base, 'skills'))) skills.push({ ...s, source, pluginId: null });
  }
  for (const p of pluginRows || []) {
    if (!p.enabled || !p.installed || !p.installPath) continue;
    for (const a of await safe(listers.listAgents, path.join(p.installPath, 'agents'))) agents.push({ ...a, source: 'plugin', pluginId: p.pluginId });
    for (const s of await safe(listers.listSkills, path.join(p.installPath, 'skills'))) skills.push({ ...s, source: 'plugin', pluginId: p.pluginId });
  }
  return { agents, skills };
}

// Deny-rule names that match no row, so the audit can flag typos and
// agents that were deleted after being denied.
function denyUnmatched(scopes, agentRows, skillRows) {
  const agentNames = new Set();
  for (const a of agentRows || []) {
    agentNames.add(a.name);
    if (a.source === 'plugin') agentNames.add(`${pluginShortName(a.pluginId)}:${a.name}`);
  }
  const skillNames = new Set((skillRows || []).map((s) => s.name));
  const agents = new Set();
  const skills = new Set();
  for (const s of SCOPE_ORDER) {
    const obj = scopes && scopes[s];
    if (!obj || !obj.permissions) continue;
    const rules = parseDenyRules(obj.permissions.deny);
    for (const n of rules.agents) if (!agentNames.has(n)) agents.add(n);
    for (const n of rules.skills) if (!skillNames.has(n)) skills.add(n);
  }
  return { agents: [...agents].sort(), skills: [...skills].sort() };
}

// The whole thing for one project. `inventory` is lib/inventory.js's
// readInventory() result, passed in so the endpoint reads it once.
async function readToolset(root, inventory) {
  const { scopes, files, unreadable } = await readScopes(root);
  const plugins = resolvePlugins((inventory && inventory.plugins) || [], scopes);
  const candidates = await collectCandidates(root, plugins);
  const agents = resolveAgents(candidates.agents, scopes);
  const skills = resolveSkills(candidates.skills, scopes, plugins);
  const mcp = resolveMcp((inventory && inventory.mcp) || [], root);
  const ts = { plugins, agents, skills, mcp, denyUnmatched: denyUnmatched(scopes, agents, skills) };
  const audit = auditToolset(ts, unreadable);
  attachRecipes(ts, root);
  return { plugins, agents, skills, mcp, audit, files };
}
```

Add `readJsonStatus, readScopes, collectCandidates, denyUnmatched, readToolset` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Wire the endpoint**

In `server.js`, add to the requires near the top:

```js
const { readToolset } = require('./lib/toolset');
```

In the real `/api/project` handler, change `Promise.all([projectDetail(known), recentCommits(known)])` and its `.then` to:

```js
    Promise.all([projectDetail(known), recentCommits(known), readInventory(collector.projectPaths())])
      .then(async ([detail, commits, inventory]) => {
        detail.sessions = collector.allSessions(known);
        detail.commits = linkCommitsToSessions(commits, detail.sessions);
        detail.muted = isProjectMuted(known, cfg.readConfig().mutedProjects);
        detail.toolset = await readToolset(known, inventory);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(detail));
      })
```

(keep the existing `.catch`). In the demo branch, add `toolset: demoToolset(),` to the returned object and add `demoToolset` to the `require('./lib/demo')` destructuring.

- [ ] **Step 6: Demo fixture**

In `lib/demo.js`, add before `module.exports`:

```js
// A believable toolset for the demo project drawer.
function demoToolset() {
  const local = '.claude/settings.local.json';
  const rec = (label, obj) => ({ label, text: JSON.stringify(obj, null, 2), target: local });
  const mcpRec = (name, on) => ({ label: `${on ? 'disable' : 'enable'} MCP server ${name}`, text: `Run /mcp inside a Claude session in this project and toggle ${name}.`, target: 'a Claude session in this project' });
  return {
    files: { managed: false, local: true, project: true, user: true },
    audit: [
      { level: 'warn', text: 'plugin ado-skills is enabled by user settings but not installed' },
      { level: 'info', text: 'agent reviewer (project) shadows plugin:ecc' },
    ],
    plugins: [
      { name: 'superpowers', kind: 'plugin', enabled: true, source: 'user', pluginId: 'superpowers@claude-plugins-official', decidedBy: 'user', shadowed: [], description: null, installed: true, stale: false, recipe: rec('disable plugin superpowers', { enabledPlugins: { 'superpowers@claude-plugins-official': false } }) },
      { name: 'ecc', kind: 'plugin', enabled: true, source: 'user', pluginId: 'ecc@claude-plugins-official', decidedBy: 'local', shadowed: [], description: null, installed: true, stale: false, recipe: rec('disable plugin ecc', { enabledPlugins: { 'ecc@claude-plugins-official': false } }) },
      { name: 'ado-skills', kind: 'plugin', enabled: true, source: 'user', pluginId: 'ado-skills@bt-ai-tools', decidedBy: 'user', shadowed: [], description: null, installed: false, stale: false, recipe: rec('disable plugin ado-skills', { enabledPlugins: { 'ado-skills@bt-ai-tools': false } }) },
      { name: 'figma', kind: 'plugin', enabled: false, source: 'user', pluginId: 'figma@claude-plugins-official', decidedBy: 'project', shadowed: [], description: null, installed: true, stale: false, recipe: rec('enable plugin figma', { enabledPlugins: { 'figma@claude-plugins-official': true } }) },
    ],
    agents: [
      { name: 'reviewer', kind: 'agent', enabled: true, source: 'project', pluginId: null, decidedBy: 'default', shadowed: ['plugin:ecc'], description: 'Reviews a diff for correctness', recipe: rec('disable agent reviewer', { permissions: { deny: ['Agent(reviewer)'] } }) },
      { name: 'code-explorer', kind: 'agent', enabled: true, source: 'plugin', pluginId: 'ecc@claude-plugins-official', decidedBy: 'default', shadowed: [], description: 'Traces execution paths', recipe: rec('disable agent code-explorer', { permissions: { deny: ['Agent(ecc:code-explorer)'] } }) },
      { name: 'planner', kind: 'agent', enabled: false, source: 'user', pluginId: null, decidedBy: 'local', shadowed: [], description: null, recipe: { label: 'enable agent planner', text: 'Remove the "Agent(planner)" (or "Task(planner)") entry from permissions.deny in .claude/settings.local.json.', target: local } },
    ],
    skills: [
      { name: 'brainstorming', kind: 'skill', enabled: true, mode: null, source: 'plugin', pluginId: 'superpowers@claude-plugins-official', decidedBy: 'plugin', shadowed: [], description: 'Design before code', recipe: rec('disable plugin superpowers', { enabledPlugins: { 'superpowers@claude-plugins-official': false } }) },
      { name: 'deploy', kind: 'skill', enabled: true, mode: 'user-invocable-only', source: 'project', pluginId: null, decidedBy: 'local', shadowed: [], description: 'Ship to staging', recipe: rec('turn off skill deploy', { skillOverrides: { deploy: 'off' } }) },
      { name: 'legacy-notes', kind: 'skill', enabled: false, mode: 'off', source: 'user', pluginId: null, decidedBy: 'user', shadowed: [], description: null, recipe: rec('turn on skill legacy-notes', { skillOverrides: { 'legacy-notes': 'on' } }) },
    ],
    mcp: [
      { name: 'github', kind: 'mcp', enabled: true, source: 'global', pluginId: null, decidedBy: 'default', shadowed: [], description: 'http · https://api.githubcopilot.com/…', needsAuth: false, recipe: mcpRec('github', true) },
      { name: 'postgres', kind: 'mcp', enabled: false, source: 'project', pluginId: null, decidedBy: 'claude.json', shadowed: [], description: 'stdio', needsAuth: false, recipe: mcpRec('postgres', false) },
    ],
  };
}
```

Add `demoToolset` to `module.exports`.

- [ ] **Step 7: Verify**

Run (plain commands, one at a time if the shell wrapper requires it):
```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
CLAUDE_DASH_PORT=4599 node server.js &
```
then, with `<path>` being one entry from `curl -s http://127.0.0.1:4599/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).projects[0].path))'` (URL-encode spaces as `%20`):
```bash
curl -s "http://127.0.0.1:4599/api/project?path=<path>" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).toolset;console.log("plugins",t.plugins.length,"agents",t.agents.length,"skills",t.skills.length,"mcp",t.mcp.length,"audit",t.audit.length,"files",JSON.stringify(t.files));console.log(t.agents.slice(0,2))})'
```
Expected: non-zero plugin and skill counts on this machine (superpowers and ecc are enabled), agents from enabled plugins, each row carrying `recipe`. Then the demo: `kill <pid>`, `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_PORT=4599 node server.js &`, `curl -s "http://127.0.0.1:4599/api/project?path=x" | grep -o '"toolset":{"files"'` prints one match; `kill <pid>`.

- [ ] **Step 8: Commit**

```bash
git add lib/toolset.js server.js lib/demo.js test/pure-logic.test.js
git commit -m "Toolset: settings scopes, candidate collection, readToolset on /api/project"
```

---

### Task 6: Reveal a settings file — `lib/opener.js` and `POST /api/reveal-file`

**Files:**
- Modify: `lib/opener.js` (add `revealTarget`, `revealCommand`, `revealFile`)
- Modify: `server.js` (new handler before the final 404; demo branch)
- Test: `test/pure-logic.test.js` (append)

**Interfaces:**
- Produces:
  - `revealTarget(which) -> string | null` — `'local' → '.claude/settings.local.json'`, `'project' → '.claude/settings.json'`, `'mcpJson' → '.mcp.json'`, anything else `null`.
  - `revealCommand(platform, abs) -> [cmd, args[]]` — darwin `['open', ['-R', abs]]`; win32 `['explorer', ['/select,' + abs]]`; otherwise `['xdg-open', [path.dirname(abs)]]`.
  - `revealFile(abs) -> Promise<{ ok, error? }>`.
  - `POST /api/reveal-file` body `{ path, which }` → `{ ok: true }` | 400 `unknown target` | 404 `unknown project` | 404 `no such file` | 500 with the launcher error.

- [ ] **Step 1: Write the failing tests**

Append to `test/pure-logic.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok" | head -2`
Expected: `revealTarget is not a function`.

- [ ] **Step 3: Implement in `lib/opener.js`**

Add before `module.exports`:

```js
// The three files the toolset view may reveal, keyed by a fixed name so
// the client never sends a path of its own.
const REVEAL_FILES = { local: '.claude/settings.local.json', project: '.claude/settings.json', mcpJson: '.mcp.json' };

function revealTarget(which) {
  return Object.prototype.hasOwnProperty.call(REVEAL_FILES, which) ? REVEAL_FILES[which] : null;
}

// argv form only — nothing here passes through a shell.
function revealCommand(platform, abs) {
  if (platform === 'darwin') return ['open', ['-R', abs]];
  if (platform === 'win32') return ['explorer', [`/select,${abs}`]];
  return ['xdg-open', [path.dirname(abs)]];
}

// Show the file in the OS file manager. `abs` is composed server-side
// from a collector-known project root and a REVEAL_FILES entry.
function revealFile(abs) {
  const [cmd, args] = revealCommand(process.platform, abs);
  return run(cmd, args);
}
```

Export: `module.exports = { openSession, openNewSession, revealTarget, revealCommand, revealFile };`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: The endpoint**

In `server.js`, change the opener require to `const { openSession, openNewSession, revealTarget, revealFile } = require('./lib/opener');`. Insert this handler directly before the final `res.writeHead(404, …)` / `not found` block (after the `/api/open` handler):

```js
  // Reveal one of three fixed settings files inside a known project in
  // the OS file manager. The client sends a project path and a key; the
  // server composes the absolute path itself and refuses anything else.
  if (url === '/api/reveal-file' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' });
    readBody(req, res, async (payload) => {
      const rel = revealTarget(String(payload.which || ''));
      if (!rel) return json(res, 400, { ok: false, error: 'unknown target' });
      const known = collector
        .projectPaths()
        .find((p) => p.toLowerCase() === String(payload.path || '').toLowerCase());
      if (!known) return json(res, 404, { ok: false, error: 'unknown project' });
      const abs = path.join(known, rel);
      if (!fs.existsSync(abs)) return json(res, 404, { ok: false, error: 'no such file' });
      const result = await revealFile(abs);
      json(res, result.ok ? 200 : 500, result);
    });
    return;
  }
```

(`fs`, `path`, `sameOrigin`, `readBody`, `json` already exist in `server.js`.) In the demo branch, add before its other handlers: `if (url === '/api/reveal-file') return json(res, 200, { ok: true });`.

- [ ] **Step 6: Verify the refusals and one success**

Run `CLAUDE_DASH_PORT=4599 node server.js &` and, with `<path>` a known project path that has a `.claude/settings.json` (find one with `ls <path>/.claude/settings.json`):
```bash
curl -s -X POST http://127.0.0.1:4599/api/reveal-file -H 'Content-Type: application/json' -d '{"path":"/nope","which":"local"}'
curl -s -X POST http://127.0.0.1:4599/api/reveal-file -H 'Content-Type: application/json' -d '{"path":"<path>","which":"../x"}'
curl -s -X POST http://127.0.0.1:4599/api/reveal-file -H 'Content-Type: application/json' -d '{"path":"<path>","which":"mcpJson"}'
curl -s -X POST http://127.0.0.1:4599/api/reveal-file -H 'Origin: http://evil.example' -H 'Content-Type: application/json' -d '{"path":"<path>","which":"local"}'
```
Expected, in order: `{"ok":false,"error":"unknown project"}`, `{"ok":false,"error":"unknown target"}`, either `{"ok":true}` with a Finder window selecting the file or `{"ok":false,"error":"no such file"}` when the project has no `.mcp.json`, and `{"ok":false,"error":"forbidden"}`. Kill the server by PID.

- [ ] **Step 7: Commit**

```bash
git add lib/opener.js server.js test/pure-logic.test.js
git commit -m "Reveal a project's settings file: validated POST /api/reveal-file"
```

---

### Task 7: UI — the Toolset section, copy recipes, reveal buttons

**Files:**
- Modify: `public/index.html` (CSS after the `.stat-table td:last-child …` rule ~line 745; `renderDetail` ~1501-1551; the `.copy` click handler ~1395-1418)
- Modify: `README.md` ("Project details" bullet; a new "Toolset" bullet)

**Interfaces:**
- Consumes: `/api/project` `toolset` (Task 5); `POST /api/reveal-file` (Task 6); `esc`, `dSection`, `toast`, `$`.
- Produces: `toolsetRow(r) -> html`, `toolsetHtml(t, projectPath) -> html | null`; buttons carrying `data-recipe` / `data-recipe-target` and `data-reveal` / `data-reveal-path`.

- [ ] **Step 1: CSS**

After the `.stat-table td:last-child, …` rule add:

```css
  .ts-audit { margin: 0 0 10px; padding-left: 18px; font-size: 12px; color: var(--warn); }
  .ts-audit li.info { color: var(--muted); }
  .ts-table td { text-align: left; }
  .ts-table td:last-child { text-align: right; width: 32px; }
  .ts-table td:nth-child(2) { text-align: left; white-space: nowrap; }
  .ts-state { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--line); }
  .ts-state.on { color: var(--accent); }
  .ts-state.off { color: var(--faint); }
  .ts-src { font-size: 11px; color: var(--faint); margin-left: 6px; }
  .ts-shadow { font-size: 11px; color: var(--muted); margin-left: 6px; }
  .ts-foot { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .ts-sub { font-weight: 600; font-size: 12px; margin: 10px 0 2px; color: var(--muted); }
```

- [ ] **Step 2: The section renderer**

Add before `function renderDetail(d, name)`:

```js
// One row per plugin/agent/skill/server with state, source, the scope that
// decided it, and a copy button for the recipe that flips it.
function toolsetRow(r) {
  const state = r.enabled ? (r.mode && r.mode !== 'on' ? r.mode : 'on') : 'off';
  const decided = r.decidedBy === 'default' ? '' : ` · by ${r.decidedBy}`;
  const src = r.source === 'plugin' ? `plugin:${esc(String(r.pluginId || '').split('@')[0])}` : esc(r.source);
  return `<tr>
    <td><span title="${esc(r.description || '')}">${esc(r.name)}</span>${
      r.installed === false ? ' <span class="badge" title="enabled in settings but not installed">not installed</span>' : ''}${
      r.stale ? ' <span class="badge" title="marketplace refreshed after this plugin was last updated">stale</span>' : ''}${
      r.needsAuth ? ' <span class="badge" style="color:var(--warn)">needs auth</span>' : ''}${
      r.shadowed && r.shadowed.length ? ` <span class="ts-shadow" title="${esc('lower-precedence copies: ' + r.shadowed.join(', '))}">shadows ${r.shadowed.length}</span>` : ''}</td>
    <td><span class="ts-state ${r.enabled ? 'on' : 'off'}">${esc(state)}</span><span class="ts-src">${src}${esc(decided)}</span></td>
    <td>${r.recipe ? `<button class="copy" data-recipe="${esc(r.recipe.text)}" data-recipe-target="${esc(r.recipe.target)}" title="${esc(`Copy: ${r.recipe.label}`)}">⧉</button>` : ''}</td>
  </tr>`;
}

function toolsetHtml(t, projectPath) {
  if (!t) return null;
  const audit = (t.audit || []).length
    ? `<ul class="ts-audit">${t.audit.map((a) => `<li class="${a.level === 'info' ? 'info' : ''}">${esc(a.text)}</li>`).join('')}</ul>` : '';
  const table = (label, rows, empty) => `<div class="ts-sub">${esc(label)} — ${rows.length}</div>${
    rows.length ? `<table class="stat-table ts-table">${rows.map(toolsetRow).join('')}</table>` : `<div class="d-empty">${esc(empty)}</div>`}`;
  const fileBtn = (which, label) => t.files && t.files[which]
    ? `<button class="copy" data-reveal="${which}" data-reveal-path="${esc(projectPath)}" title="Reveal in the file manager">open ${esc(label)}</button>`
    : `<button class="copy" data-recipe="{}" data-recipe-target="${esc(label)}" title="This file does not exist yet — copies an empty object to start it">create ${esc(label)}</button>`;
  return audit +
    table('Plugins', t.plugins || [], 'No plugins installed.') +
    table('Agents', t.agents || [], 'No agents from the project, your user dir, or enabled plugins.') +
    table('Skills', t.skills || [], 'No skills from the project, your user dir, or enabled plugins.') +
    table('MCP servers', t.mcp || [], 'No MCP servers apply to this project.') +
    `<div class="ts-foot">${fileBtn('local', '.claude/settings.local.json')}${fileBtn('project', '.claude/settings.json')}${
      t.files && t.files.mcpJson ? fileBtn('mcpJson', '.mcp.json') : ''}</div>`;
}
```

- [ ] **Step 3: Insert the section**

`t.files` from the server has `managed/local/project/user` flags only; `.mcp.json` presence comes from `projectDetail`'s `settings.mcpJson`. In `renderDetail`, before the `$('#d-body').innerHTML =` assignment add:

```js
  const tsFiles = { ...((d.toolset && d.toolset.files) || {}), mcpJson: !!(d.settings && d.settings.mcpJson) };
  const ts = d.toolset ? { ...d.toolset, files: tsFiles } : null;
  const KINDS = ['plugins', 'agents', 'skills', 'mcp'];
  const tsOn = ts ? KINDS.reduce((n, k) => n + (ts[k] || []).filter((r) => r.enabled).length, 0) : 0;
  const tsOff = ts ? KINDS.reduce((n, k) => n + (ts[k] || []).filter((r) => !r.enabled).length, 0) : 0;
```

and in the concatenation, directly before `dSection('Settings', …)`:

```js
    dSection(`Toolset — ${tsOn} on · ${tsOff} off`, toolsetHtml(ts, d.path), 'Toolset unavailable.') +
```

- [ ] **Step 4: Click handling and the `.copy` fall-through guard**

In the `document.addEventListener('click', async (e) => { const btn = e.target.closest('.copy'); …` handler (the one whose last line is `navigator.clipboard.writeText(btn.dataset.cmd).then(() => toast('Resume command copied'));`), insert directly after the `if (btn.dataset.open) { … return; }` block:

```js
  if (btn.dataset.recipe !== undefined) {
    try {
      await navigator.clipboard.writeText(btn.dataset.recipe);
      toast(`Copied — merge into ${btn.dataset.recipeTarget}`);
    } catch {
      toast('Clipboard blocked by the browser');
    }
    return;
  }
  if (btn.dataset.reveal) {
    try {
      const r = await fetch('/api/reveal-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: btn.dataset.revealPath, which: btn.dataset.reveal }),
      });
      const out = await r.json();
      toast(out.ok ? 'Revealed in the file manager' : `Couldn't reveal: ${out.error}`);
    } catch {
      toast("Couldn't reach the server");
    }
    return;
  }
  if (btn.dataset.cmd === undefined) return; // other .copy buttons have their own handlers
```

The last line fixes a pre-existing fall-through: every `.copy` button without `data-cmd` (note, pin, usage toggle, mute…) also reached the resume-command branch and wrote the string "undefined" to the clipboard with a "Resume command copied" toast. Verify the claim before relying on it: `grep -n "dataset.cmd" public/index.html` shows the single unguarded `writeText(btn.dataset.cmd)`; if a guard already exists, skip this line and say so in the report.

- [ ] **Step 5: README**

In "What you're looking at", after the **Project details** bullet add:

```
- **Toolset** — inside the project slide-over: what Claude Code would actually use in that project. Every installed plugin, every agent and skill from the project, your user dir, and enabled plugins, and every MCP server that applies, each marked on or off with where it came from and which settings scope decided it, resolved with Claude Code's own precedence (managed › local › project › user, deny beats allow, project agents shadow user agents shadow plugin agents). An amber list at the top flags things worth a look: a plugin enabled but not installed or gone stale, a deny rule naming an agent that no longer exists, a server that needs auth, a settings file that doesn't parse. The `⧉` on a row copies the exact snippet to flip it, aimed at `.claude/settings.local.json`; MCP toggles live in Claude's own registry, so that recipe tells you to run `/mcp` in a session instead. Buttons at the foot reveal the project's settings files in Finder. Read-only — the dashboard never edits Claude configuration.
```

In the **Project details** bullet, change "and settings (permissions, MCP servers, allowed tools). Read-only;" to "and settings (permissions, MCP servers, allowed tools), plus the resolved **Toolset** below. Read-only;".

- [ ] **Step 6: Verify**

`npm test` stays green. Syntax: `sed -n '/<script>/,/<\/script>/p' public/index.html | sed '1d;$d' > /tmp/claude-dash-ui.js` then `node --check /tmp/claude-dash-ui.js`. Render-level check (no browser in this environment): write a scratch Node script that slices the inline script, extracts `esc`, `toolsetRow`, `toolsetHtml` by `function NAME(` string search (ending at the first `\n}\n`), evaluates them with `new Function`, feeds `demoToolset()` from `lib/demo.js` (with `files.mcpJson = true`), and asserts: four `ts-sub` headings, a `ts-audit` list with two `<li>`, every row has a `data-recipe` button, the `not installed` badge and `shadows 1` render, a hostile name `<img src=x>` is escaped, and the foot has three buttons. Then start `CLAUDE_DASH_DEMO=1 CLAUDE_DASH_PORT=4599 node server.js`, `curl -s http://127.0.0.1:4599/ | grep -c "function toolsetHtml"` → 1, kill by PID.

- [ ] **Step 7: Commit**

```bash
git add public/index.html README.md
git commit -m "Project drawer: resolved toolset with recipes and reveal buttons; guard .copy fall-through"
```

---

### Task 8: Smoke test on real data

**Files:** none unless a bug turns up.

- [ ] **Step 1:** `npm test` → `fail 0`.
- [ ] **Step 2:** Real mode on 4599: for this repository's own project path, `curl` `/api/project` and confirm: the `superpowers` and `ecc` plugins appear enabled; `brainstorming`, `writing-plans` etc. appear under skills with `source: 'plugin'`; the agents list includes ecc's agents; `audit` is empty or lists only real conditions; every row has a `recipe` whose `text` parses as JSON for plugin, enabled-agent, and skill rows.
- [ ] **Step 3:** Reveal: POST `/api/reveal-file` for a known project with `which: 'project'` where that file exists; Finder opens with the file selected. (Any known project that has a `.claude/settings.local.json` also works with `which: 'local'`.)
- [ ] **Step 4:** Browser pass (user, after merge, on 4517): the Toolset section in a drawer; hover descriptions; a `⧉` click toasts "Copied — merge into .claude/settings.local.json" and the clipboard holds the snippet; "open .claude/settings.json" reveals the file.

## Ordering

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Tasks 3 and 4 are pure and could be reviewed together; they are split so each has its own test cycle.
