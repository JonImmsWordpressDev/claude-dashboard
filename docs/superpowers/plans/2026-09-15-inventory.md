# Plugin and MCP Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One read-only view listing every installed Claude Code plugin (with version, enabled state, staleness) and every configured MCP server (with scope, projects using it, and an auth-needed flag).

**Architecture:** A new `lib/inventory.js` reads six read-only sources and merges them with two pure functions, `mergePlugins` and `mergeMcp`. `GET /api/inventory` serves the result on demand (not polled). The UI is a drawer view like Stats, reached from ⌘K and a settings link.

**Tech Stack:** Node ≥ 18, zero dependencies, `node:test`, vanilla JS in `public/index.html`.

**Spec:** `docs/superpowers/specs/2026-09-15-inventory-design.md`

## Global Constraints

- Never write to anything under `~/.claude` or to `~/.claude.json`. Read only.
- Zero npm dependencies.
- Secrets never leave the server: `env` and `headers` blocks in MCP server definitions are stripped; only `command`, `args` count, `url`, and `type` are surfaced.
- Project `.mcp.json` reads are confined to collector-known project roots (`collector.projectPaths()`).
- Work on branch `feature-batch-2026-09`. Run `npm test` before every commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Source shapes (verified on this machine)

- `~/.claude/plugins/installed_plugins.json`: `{ version: 2, plugins: { "<name>@<marketplace>": [{ scope, installPath, version, installedAt, lastUpdated, gitCommitSha? }] } }`
- `~/.claude/settings.json`: `{ enabledPlugins: { "<name>@<marketplace>": true|false } }`
- `~/.claude/plugins/known_marketplaces.json`: `{ "<marketplace>": { source: { source, repo }, installLocation, lastUpdated } }`
- `~/.claude.json`: `{ mcpServers?: { name: def }, projects: { "<path>": { mcpServers?: { name: def }, disabledMcpServers?, enabledMcpjsonServers?, disabledMcpjsonServers? } } }`
- `<project>/.mcp.json`: `{ mcpServers: { name: def } }`
- `~/.claude/mcp-needs-auth-cache.json`: `{ "<server name>": { timestamp, id } }`
- A server `def` is `{ type?: 'stdio'|'http'|'sse', command?, args?, url?, env?, headers? }`.

## File map

| File | Change |
|---|---|
| `lib/inventory.js` (new) | `mergePlugins`, `mergeMcp`, `publicServer` (pure); `readInventory(projectPaths)` (async, read-only). |
| `server.js` | `GET /api/inventory`; demo branch. |
| `lib/demo.js` | `demoInventory()`. |
| `public/index.html` | `openInventory()` drawer view; ⌘K item; settings link; small CSS. |
| `test/pure-logic.test.js` | Tests for the three pure functions. |
| `README.md` | Bullet. |

---

### Task 1: Pure merge helpers

**Files:**
- Create: `lib/inventory.js`
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces: `mergePlugins(installed, enabledMap, marketplaces, now) -> [{ id, name, marketplace, version, installedAt, lastUpdated, enabled, installed, stale }]` sorted enabled-first then by name.
- Produces: `publicServer(def) -> { type, command, args, url }` with secrets removed (`args` is a count, not the values).
- Produces: `mergeMcp({ global, byProject, mcpJsonByProject, needsAuth }) -> [{ name, scope: 'global'|'project'|'mcp.json', projects: string[], type, command, url, args, needsAuth }]` — one row per name+scope, projects deduped and sorted.

- [ ] **Step 1: Write the failing tests**

```js
const { mergePlugins, mergeMcp, publicServer } = require('../lib/inventory');

const DAY = 86400000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

test('mergePlugins joins installs with enabled state and marketplace freshness', () => {
  const installed = {
    'superpowers@official': [{ scope: 'user', version: 'abc123', installedAt: '2026-08-01T00:00:00Z', lastUpdated: '2026-08-20T00:00:00Z' }],
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern="mergePlugins|publicServer|mergeMcp" test/pure-logic.test.js` — FAIL, `Cannot find module '../lib/inventory'`.

- [ ] **Step 3: Create `lib/inventory.js` (pure part)**

```js
'use strict';
// Plugins and MCP servers across the whole Claude Code install. Read-only;
// secrets in server definitions never leave this module.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { CLAUDE_DIR, canonicalize } = require('./paths');

const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

function ms(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}

function mergePlugins(installed, enabledMap, marketplaces, now = Date.now()) {
  const ids = new Set([...Object.keys(installed || {}), ...Object.keys(enabledMap || {})]);
  const rows = [];
  for (const id of ids) {
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : '';
    const inst = Array.isArray(installed && installed[id]) ? installed[id][0] : null;
    const market = marketplaces && marketplaces[marketplace];
    const updated = inst ? ms(inst.lastUpdated) : null;
    const marketUpdated = market ? ms(market.lastUpdated) : null;
    rows.push({
      id, name, marketplace,
      version: inst ? String(inst.version || '') : null,
      installedAt: inst ? ms(inst.installedAt) : null,
      lastUpdated: updated,
      enabled: !!(enabledMap && enabledMap[id]),
      installed: !!inst,
      stale: !!(inst && updated !== null && marketUpdated !== null && marketUpdated - updated > STALE_GRACE_MS),
    });
  }
  rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return rows;
}

function publicServer(def) {
  const d = def && typeof def === 'object' ? def : {};
  const url = typeof d.url === 'string' ? d.url : null;
  return {
    type: d.type || (url ? 'http' : 'stdio'),
    command: typeof d.command === 'string' ? d.command : null,
    args: Array.isArray(d.args) ? d.args.length : 0,
    url,
  };
}

function mergeMcp({ global, byProject, mcpJsonByProject, needsAuth }) {
  const rows = new Map(); // `${scope}\n${name}` -> row
  const add = (name, scope, def, project) => {
    const key = `${scope}\n${name}`;
    let row = rows.get(key);
    if (!row) {
      row = { name, scope, projects: [], ...publicServer(def), needsAuth: !!(needsAuth && needsAuth[name]) };
      rows.set(key, row);
    }
    if (project && !row.projects.includes(project)) row.projects.push(project);
  };
  for (const [name, def] of Object.entries(global || {})) add(name, 'global', def, null);
  for (const [project, servers] of Object.entries(byProject || {})) {
    for (const [name, def] of Object.entries(servers || {})) add(name, 'project', def, project);
  }
  for (const [project, servers] of Object.entries(mcpJsonByProject || {})) {
    for (const [name, def] of Object.entries(servers || {})) add(name, 'mcp.json', def, project);
  }
  const out = [...rows.values()];
  for (const r of out) r.projects.sort();
  out.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return out;
}

module.exports = { mergePlugins, publicServer, mergeMcp };
```

- [ ] **Step 4: Run tests, commit**

Run: `npm test` — PASS.

```bash
git add lib/inventory.js test/pure-logic.test.js
git commit -m "Pure merges for the plugin and MCP inventory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Reader, endpoint, demo

**Files:**
- Modify: `lib/inventory.js` (append `readInventory`, extend exports), `server.js` (import, demo branch, route after `/api/stats` at line 253), `lib/demo.js` (`demoInventory`, exports)

**Interfaces:**
- Produces: `readInventory(projectPaths: string[]) -> { plugins, marketplaces: [{ name, repo, lastUpdated }], mcp, summary: { plugins, enabled, servers, needAuth } }`.
- Produces: `GET /api/inventory`.

- [ ] **Step 1: Append the reader**

```js
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readInventory(projectPaths) {
  const [installedRaw, settings, marketsRaw, claudeJson, needsAuth] = await Promise.all([
    readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), {}),
    readJson(path.join(CLAUDE_DIR, 'settings.json'), {}),
    readJson(path.join(CLAUDE_DIR, 'plugins', 'known_marketplaces.json'), {}),
    readJson(path.join(os.homedir(), '.claude.json'), {}),
    readJson(path.join(CLAUDE_DIR, 'mcp-needs-auth-cache.json'), {}),
  ]);
  const plugins = mergePlugins(installedRaw.plugins || {}, settings.enabledPlugins || {}, marketsRaw);
  const marketplaces = Object.entries(marketsRaw).map(([name, m]) => ({
    name, repo: m && m.source && m.source.repo ? m.source.repo : null, lastUpdated: ms(m && m.lastUpdated),
  }));

  const known = new Map(projectPaths.map((p) => [canonicalize(p).toLowerCase(), p]));
  const byProject = {};
  for (const [p, info] of Object.entries(claudeJson.projects || {})) {
    const display = known.get(canonicalize(p).toLowerCase());
    if (display && info && info.mcpServers && Object.keys(info.mcpServers).length) byProject[display] = info.mcpServers;
  }
  const mcpJsonByProject = {};
  await Promise.all(projectPaths.map(async (p) => {
    const j = await readJson(path.join(p, '.mcp.json'), null);
    if (j && j.mcpServers && Object.keys(j.mcpServers).length) mcpJsonByProject[p] = j.mcpServers;
  }));
  const mcp = mergeMcp({ global: claudeJson.mcpServers || {}, byProject, mcpJsonByProject, needsAuth });
  return {
    plugins, marketplaces, mcp,
    summary: {
      plugins: plugins.filter((p) => p.installed).length,
      enabled: plugins.filter((p) => p.enabled).length,
      servers: mcp.length,
      needAuth: mcp.filter((m) => m.needsAuth).length,
    },
  };
}

module.exports = { mergePlugins, publicServer, mergeMcp, readInventory };
```

- [ ] **Step 2: Endpoint**

`server.js`: add `const { readInventory } = require('./lib/inventory');` after line 20, and add `demoInventory` to the demo import. In the demo branch add `if (url === '/api/inventory') return json(res, 200, demoInventory());`. After the `/api/stats` route (line 253) add:

```js
  if (url === '/api/inventory') {
    readInventory(collector.projectPaths())
      .then((inv) => json(res, 200, inv))
      .catch((e) => json(res, 500, { error: String(e.message).slice(0, 200) }));
    return;
  }
```

- [ ] **Step 3: Demo fixture**

Append to `lib/demo.js` and export:

```js
function demoInventory() {
  const now = Date.now();
  return {
    plugins: [
      { id: 'superpowers@claude-plugins-official', name: 'superpowers', marketplace: 'claude-plugins-official', version: '6.3.0', installedAt: now - 40 * DAY, lastUpdated: now - 2 * DAY, enabled: true, installed: true, stale: false },
      { id: 'playwright@claude-plugins-official', name: 'playwright', marketplace: 'claude-plugins-official', version: 'f0dce59fec06', installedAt: now - 90 * DAY, lastUpdated: now - 20 * DAY, enabled: true, installed: true, stale: true },
      { id: 'frontend-design@claude-plugins-official', name: 'frontend-design', marketplace: 'claude-plugins-official', version: 'f0dce59fec06', installedAt: now - 60 * DAY, lastUpdated: now - 2 * DAY, enabled: true, installed: true, stale: false },
      { id: 'figma@claude-plugins-official', name: 'figma', marketplace: 'claude-plugins-official', version: '2.2.111', installedAt: now - 30 * DAY, lastUpdated: now - 2 * DAY, enabled: false, installed: true, stale: false },
      { id: 'code-review@claude-code-plugins', name: 'code-review', marketplace: 'claude-code-plugins', version: null, installedAt: null, lastUpdated: null, enabled: false, installed: false, stale: false },
    ],
    marketplaces: [
      { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official', lastUpdated: now - 2 * DAY },
      { name: 'claude-code-plugins', repo: 'anthropics/claude-code', lastUpdated: now - 2 * DAY },
    ],
    mcp: [
      { name: 'playwright', scope: 'mcp.json', projects: ['/demo/acme-storefront'], type: 'stdio', command: 'npx', args: 1, url: null, needsAuth: false },
      { name: 'ruflo', scope: 'project', projects: ['/demo/acme-storefront', '/demo/blog-engine'], type: 'stdio', command: 'ruflo', args: 0, url: null, needsAuth: false },
      { name: 'sentry', scope: 'global', projects: [], type: 'http', command: null, args: 0, url: 'https://mcp.sentry.dev/mcp', needsAuth: true },
    ],
    summary: { plugins: 4, enabled: 3, servers: 3, needAuth: 1 },
  };
}
```

- [ ] **Step 4: Verify**

Run `node server.js`; `curl -s http://127.0.0.1:4517/api/inventory | node -e "const i=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(i.summary, i.plugins.slice(0,2), i.mcp)"`. Expected: real counts, and `grep -c '"env"' <<< "$(curl -s http://127.0.0.1:4517/api/inventory)"` prints 0.

- [ ] **Step 5: Commit**

```bash
npm test
git add lib/inventory.js server.js lib/demo.js
git commit -m "GET /api/inventory: plugins and MCP servers across the install

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: UI

**Files:**
- Modify: `public/index.html` — CSS after `.stat-totals strong` (line 695); new `openInventory` after `openStats`'s closing brace (before `// ---------- catch-up` near line 2258); palette item at 2373; settings row after the Version row (around line 1912).

- [ ] **Step 1: CSS**

```css
  .inv-chip { padding: 0 6px; border-radius: 2px; font-size: 11px; background: var(--chip-bg); color: var(--muted); }
  .inv-chip.on { color: var(--accent); }
  .inv-chip.stale, .inv-chip.auth { color: var(--warn); }
  .inv-chip.off { color: var(--faint); }
  .stat-table td.mono { font-family: inherit; }
```

- [ ] **Step 2: The view**

```js
// ---------- plugin & MCP inventory ----------
async function openInventory() {
  openDrawerShell('Plugins & MCP', 'read-only · from ~/.claude and each project');
  try {
    const r = await fetch('/api/inventory');
    if (!r.ok) throw new Error();
    const inv = await r.json();
    const s = inv.summary;
    $('#d-path').textContent = `${s.plugins} plugins (${s.enabled} enabled) · ${s.servers} MCP servers · ${s.needAuth} need auth`;
    const chip = (p) => !p.installed ? '<span class="inv-chip off" title="enabled in settings but not installed">missing</span>'
      : p.stale ? '<span class="inv-chip stale" title="the marketplace has refreshed since this plugin was updated">stale</span>'
      : p.enabled ? '<span class="inv-chip on">on</span>' : '<span class="inv-chip off">off</span>';
    const pluginRow = (p) => `<tr>
      <td>${esc(p.name)}</td>
      <td class="mono">${esc(p.marketplace)}</td>
      <td class="mono">${esc(p.version || '—')}</td>
      <td>${p.lastUpdated ? relTime(p.lastUpdated) : '—'}</td>
      <td>${chip(p)}</td>
    </tr>`;
    const on = inv.plugins.filter((p) => p.enabled);
    const off = inv.plugins.filter((p) => !p.enabled);
    const table = (rows) => `<table class="stat-table"><tr><td>plugin</td><td>marketplace</td><td>version</td><td>updated</td><td></td></tr>${rows.map(pluginRow).join('')}</table>`;
    const projName = (path) => (lastState?.projects || []).find((p) => p.path === path)?.name || path.split('/').pop();
    const mcpRow = (m) => `<tr>
      <td>${esc(m.name)}${m.needsAuth ? ' <span class="inv-chip auth" title="Claude Code reports this server needs authentication">needs auth</span>' : ''}</td>
      <td class="mono">${esc(m.scope)}</td>
      <td>${m.projects.length ? m.projects.map((p) => `<span class="badge" data-detail="${esc(p)}" style="cursor:pointer">${esc(projName(p))}</span>`).join(' ') : '<span style="color:var(--faint)">all</span>'}</td>
      <td class="mono">${esc(m.url || [m.command, m.args ? `+${m.args} args` : ''].filter(Boolean).join(' ') || m.type)}</td>
    </tr>`;
    const marketRows = inv.marketplaces.map((m) => `<tr><td>${esc(m.name)}</td><td class="mono">${esc(m.repo || '—')}</td><td>${m.lastUpdated ? relTime(m.lastUpdated) : '—'}</td></tr>`).join('');
    $('#d-body').innerHTML =
      dSection(`Plugins — ${on.length} enabled`, on.length ? table(on) : null, 'No plugins enabled.') +
      (off.length ? `<details class="d-section"><summary>show ${off.length} disabled</summary>${table(off)}</details>` : '') +
      dSection(`MCP servers — ${inv.mcp.length}`, inv.mcp.length
        ? `<table class="stat-table"><tr><td>server</td><td>scope</td><td>projects</td><td>transport</td></tr>${inv.mcp.map(mcpRow).join('')}</table>`
        : null, 'No MCP servers configured anywhere.') +
      dSection(`Marketplaces — ${inv.marketplaces.length}`, marketRows ? `<table class="stat-table">${marketRows}</table>` : null, 'No marketplaces known.');
  } catch {
    $('#d-body').innerHTML = '<div class="d-empty" style="padding:20px 0">Couldn\'t load the inventory.</div>';
  }
}
```

Clicking a project badge already opens the slide-over through the existing `[data-detail]` handler.

- [ ] **Step 3: Entry points**

In `paletteItems`, after the Stats item add:

```js
  items.push({ k: '⌗', label: 'Plugins & MCP', hint: 'what is installed, enabled, needs auth', run: openInventory });
```

and include `'⌗'` in the default (empty-query) filter list: `['⚙', '▲', '⌗', '●', '❯']`.

In `openSettings`, after the Version row add:

```html
      <div class="set-row">
        <span class="set-label">Plugins &amp; MCP servers<span class="set-sub">everything installed or configured, across all projects</span></span>
        <button class="copy" id="set-inventory">open inventory</button>
      </div>
```

and wire it near the other handlers: `$('#set-inventory').addEventListener('click', openInventory);`

- [ ] **Step 4: Check both modes**

Demo mode: the view shows three enabled plugins (one `stale`), a collapsed "show 2 disabled" section, three MCP rows with `sentry` flagged `needs auth`, and two marketplaces. Live mode: your real plugins and servers; project badges open the slide-over.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Plugins & MCP inventory view, from ⌘K and settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: README

- [ ] **Step 1: Add a bullet** after "Project details" (README line 104):

```
- **Plugins & MCP** — `⌘K` → Plugins & MCP (or the button in settings) lists every installed plugin with its marketplace, version, on/off state and a `stale` flag when the marketplace has moved on, plus every MCP server with its scope, the projects that use it, and an amber `needs auth` when Claude Code says so. Read-only; server secrets never reach the browser.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: plugin and MCP inventory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: six sources (Task 2); `mergePlugins` incl. enabled-but-missing and stale (Task 1); `mergeMcp` scopes, projects, auth (Task 1); secrets stripped (Task 1 `publicServer`, verified in Task 2 step 4); endpoint on demand (Task 2); view with two tables, collapsed disabled, summary line, clickable projects (Task 3); ⌘K and settings entry (Task 3); tests (Task 1); demo (Task 2); README (Task 4).
- Names used consistently: `mergePlugins`, `publicServer`, `mergeMcp`, `readInventory`, `demoInventory`, `openInventory`.
