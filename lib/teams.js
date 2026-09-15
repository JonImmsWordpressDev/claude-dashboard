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

// Real file names: agent-a<name>-<16 hex>.jsonl|.meta.json for named agents,
// agent-a<16 hex>.jsonl|.meta.json for unnamed ones (note the leading `a`
// right after `agent-`; verified against real files on disk). Named -> <name>;
// unnamed -> null.
function nameFromFile(fileName) {
  const name = String(fileName || '');
  const named = /^agent-a(.+)-[0-9a-f]{16}\.(?:meta\.json|jsonl)$/i.exec(name);
  if (named) return named[1];
  if (/^agent-a[0-9a-f]{16}\.(?:meta\.json|jsonl)$/i.test(name)) return null;
  return name.replace(/^agent-/, '').replace(/\.(meta\.json|jsonl)$/, '');
}

// First 8 hex chars of the unnamed agent's 16-hex hash, e.g. '#2d1d0cfa'.
function hashPrefix(fileName) {
  const m = /^agent-a([0-9a-f]{16})\.(?:meta\.json|jsonl)$/i.exec(String(fileName || ''));
  return `#${m ? m[1].slice(0, 8) : '00000000'}`;
}

function parseAgentMeta(json, fileName) {
  const j = json && typeof json === 'object' ? json : {};
  const description = typeof j.description === 'string' && j.description.trim()
    ? j.description.trim().slice(0, 60)
    : null;
  const fromFile = nameFromFile(fileName);
  const name = typeof j.name === 'string' && j.name
    ? j.name
    : description || fromFile || hashPrefix(fileName);
  return {
    name,
    type: typeof j.agentType === 'string' ? j.agentType : null,
    model: typeof j.model === 'string' ? j.model : null,
    color: typeof j.color === 'string' ? j.color : null,
    team: typeof j.teamName === 'string' && j.teamName ? j.teamName : null,
    description,
  };
}

function resolveTeam(agents, teams, sessionId) {
  const real = (t) => (t && !AUTO_TEAM.test(t) ? t : null);
  for (const a of agents || []) if (real(a.team)) return a.team;
  for (const t of teams || []) if (t.leadSessionId === sessionId && real(t.name)) return t.name;
  return null;
}

function agentColor(name) {
  const key = name ? String(name).toLowerCase() : '';
  return Object.hasOwn(COLORS, key) ? COLORS[key] : 'var(--muted)';
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

module.exports = { agentStatus, parseAgentMeta, resolveTeam, agentColor, readTeams, nameFromFile };
