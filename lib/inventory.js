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
      installPath: inst && typeof inst.installPath === 'string' ? inst.installPath : null,
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

function redactUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const firstSegment = segments.length ? `/${segments[0]}` : '';
  const suffix = segments.length > 1 ? '/…' : '';
  return `${u.origin}${firstSegment}${suffix}`;
}

function publicServer(def) {
  const d = def && typeof def === 'object' ? def : {};
  const url = typeof d.url === 'string' ? d.url : null;
  return {
    type: typeof d.type === 'string' ? d.type : (url ? 'http' : 'stdio'),
    command: typeof d.command === 'string' ? d.command : null,
    args: Array.isArray(d.args) ? d.args.length : 0,
    url: url ? redactUrl(url) : null,
  };
}

function mergeMcp({ global, byProject, mcpJsonByProject, needsAuth, disabledByProject }) {
  const rows = new Map(); // `${scope}\n${name}` -> row
  const add = (name, scope, def, project) => {
    const key = `${scope}\n${name}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        name, scope, projects: [], ...publicServer(def),
        needsAuth: !!(needsAuth && needsAuth[name]),
        disabledIn: [],
      };
      rows.set(key, row);
    }
    if (project && !row.projects.includes(project)) row.projects.push(project);
    if (project && disabledByProject && disabledByProject[project] && disabledByProject[project].has(name)
      && !row.disabledIn.includes(project)) {
      row.disabledIn.push(project);
    }
  };
  for (const [name, def] of Object.entries(global || {})) add(name, 'global', def, null);
  for (const [project, servers] of Object.entries(byProject || {})) {
    for (const [name, def] of Object.entries(servers || {})) add(name, 'project', def, project);
  }
  for (const [project, servers] of Object.entries(mcpJsonByProject || {})) {
    for (const [name, def] of Object.entries(servers || {})) add(name, 'mcp.json', def, project);
  }
  const out = [...rows.values()];
  for (const r of out) {
    r.projects.sort();
    r.disabledIn.sort();
    r.active = r.projects.length === 0 || r.disabledIn.length < r.projects.length;
  }
  const matchedNames = new Set(out.map((r) => r.name));
  for (const key of Object.keys(needsAuth || {})) {
    if (!matchedNames.has(key)) {
      out.push({
        name: key, scope: 'claude.ai', projects: [], disabledIn: [], active: true,
        type: 'remote', command: null, args: 0, url: null, needsAuth: true,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return out;
}

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
  const canonicalToInfo = new Map(
    Object.entries(claudeJson.projects || {}).map(([p, info]) => [canonicalize(p).toLowerCase(), info])
  );
  const byProject = {};
  const disabledByProject = {};
  const addDisabled = (display, names) => {
    if (!display || !names.length) return;
    if (!disabledByProject[display]) disabledByProject[display] = new Set();
    for (const n of names) disabledByProject[display].add(n);
  };
  for (const [p, info] of Object.entries(claudeJson.projects || {})) {
    const display = known.get(canonicalize(p).toLowerCase());
    if (display && info && info.mcpServers && Object.keys(info.mcpServers).length) byProject[display] = info.mcpServers;
    if (display) addDisabled(display, info && Array.isArray(info.disabledMcpServers) ? info.disabledMcpServers : []);
  }
  const mcpJsonByProject = {};
  await Promise.all(projectPaths.map(async (p) => {
    const j = await readJson(path.join(p, '.mcp.json'), null);
    if (j && j.mcpServers && Object.keys(j.mcpServers).length) {
      mcpJsonByProject[p] = j.mcpServers;
      const info = canonicalToInfo.get(canonicalize(p).toLowerCase());
      const disabledMcpjsonServers = new Set((info && info.disabledMcpjsonServers) || []);
      const enabledMcpjsonServers = new Set((info && info.enabledMcpjsonServers) || []);
      const enableAll = !!(info && info.enableAllProjectMcpServers);
      const disabled = Object.keys(j.mcpServers).filter((name) =>
        disabledMcpjsonServers.has(name) || (!enableAll && !enabledMcpjsonServers.has(name)));
      addDisabled(p, disabled);
    }
  }));
  const mcp = mergeMcp({ global: claudeJson.mcpServers || {}, byProject, mcpJsonByProject, needsAuth, disabledByProject });
  return {
    plugins, marketplaces, mcp,
    summary: {
      plugins: plugins.filter((p) => p.installed).length,
      enabled: plugins.filter((p) => p.enabled).length,
      servers: mcp.filter((m) => m.active).length,
      disabled: mcp.filter((m) => !m.active).length,
      needAuth: mcp.filter((m) => m.needsAuth).length,
    },
  };
}

module.exports = { mergePlugins, publicServer, mergeMcp, redactUrl, readInventory };
