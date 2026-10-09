'use strict';
// Effective toolset for one project: which plugins, agents, skills, and
// MCP servers Claude Code would use there, resolved with its documented
// precedence. Read-only. The pure resolvers take already-parsed settings
// objects so they can be tested without a filesystem.

const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR, managedSettingsPath } = require('./paths');
const { listAgents, listSkills } = require('./mdfiles');

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
    group.sort((a, b) => (AGENT_PRECEDENCE[a.source] ?? 9) - (AGENT_PRECEDENCE[b.source] ?? 9));
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
      const denied = denyScope(scopes, [c.name, `${pluginShortName(c.pluginId)}:${c.name}`], 'skills');
      rows.push({
        name: c.name, kind: 'skill', enabled: !denied && pluginOn.get(c.pluginId) === true, mode: null,
        source: 'plugin', pluginId: c.pluginId, decidedBy: denied || 'plugin', shadowed: [], description: c.description || null,
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
      decidedBy, deniedBy: denied || null, shadowed: [], description: c.description || null,
    });
  }
  return sortRows(rows);
}

function samePath(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// inventory.mcp rows filtered to what this project sees: global servers
// plus the ones defined for this project. Per-project on/off is what
// Claude Code stored in ~/.claude.json (disabledIn).
function resolveMcp(mcpRows, root, scopes = null) {
  const rows = [];
  for (const m of mcpRows || []) {
    const used = m.scope === 'global' || (m.projects || []).some((p) => samePath(p, root));
    if (!used) continue;
    let off = (m.disabledIn || []).some((p) => samePath(p, root));
    let decidedBy = off ? 'claude.json' : 'default';
    if (m.scope === 'mcp.json' && scopes) {
      const listed = (s, key) => scopes[s] && Array.isArray(scopes[s][key]) && scopes[s][key].includes(m.name);
      const veto = SCOPE_ORDER.find((s) => listed(s, 'disabledMcpjsonServers'));
      const ok = SCOPE_ORDER.find((s) => listed(s, 'enabledMcpjsonServers') || (scopes[s] && scopes[s].enableAllProjectMcpServers === true));
      if (veto) { off = true; decidedBy = veto; } else if (ok) { off = false; decidedBy = ok; }
    }
    rows.push({
      name: m.name,
      kind: 'mcp',
      enabled: !off,
      source: m.scope,
      pluginId: null,
      decidedBy,
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
  if (r.kind === 'skill' && r.source === 'plugin' && !r.enabled && r.decidedBy !== 'plugin') {
    return {
      label: `enable skill ${r.name}`,
      text: `Remove the "Skill(${r.name})" or "Skill(${pluginShortName(r.pluginId)}:${r.name})" entry from permissions.deny in ${r.decidedBy === 'local' ? LOCAL : `${r.decidedBy} settings`}.`,
      target: LOCAL,
    };
  }
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
  if (r.kind === 'skill' && !r.enabled && r.deniedBy) {
    return {
      label: `enable skill ${r.name}`,
      text: `Remove the "Skill(${r.name})" entry from permissions.deny in ${r.deniedBy === 'local' ? LOCAL : `${r.deniedBy} settings`}.`,
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
  if (r.source === 'mcp.json' && !r.enabled && SCOPE_ORDER.includes(r.decidedBy)) {
    return {
      label: `enable ${r.name} for this project`,
      text: `Remove "${r.name}" from disabledMcpjsonServers in ${r.decidedBy === 'local' ? LOCAL : `${r.decidedBy} settings`}.`,
      target: LOCAL,
    };
  }
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
  const skillNames = new Set();
  for (const s of skillRows || []) {
    skillNames.add(s.name);
    if (s.source === 'plugin') skillNames.add(`${pluginShortName(s.pluginId)}:${s.name}`);
  }
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
  const mcp = resolveMcp((inventory && inventory.mcp) || [], root, scopes);
  const ts = { plugins, agents, skills, mcp, denyUnmatched: denyUnmatched(scopes, agents, skills) };
  const audit = auditToolset(ts, unreadable);
  attachRecipes(ts, root);
  return { plugins, agents, skills, mcp, audit, files };
}

module.exports = {
  SCOPE_ORDER, pluginShortName, parseDenyRules, resolvePlugins, resolveAgents, resolveSkills,
  resolveMcp, auditToolset, recipeFor, attachRecipes,
  readJsonStatus, readScopes, collectCandidates, denyUnmatched, readToolset,
};
