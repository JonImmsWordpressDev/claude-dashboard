'use strict';
// Live Claude Code sessions from ~/.claude/sessions/<pid>.json.
const fs = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const STALE_MS = 24 * 60 * 60 * 1000; // updatedAt older than this => pid reuse, ignore

async function readLiveSessions() {
  let files;
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
      const pidFromName = parseInt(f, 10);
      if (!raw.pid || raw.pid !== pidFromName) continue;
      if (!isAlive(raw.pid)) continue;
      const updated = raw.statusUpdatedAt || raw.updatedAt || raw.startedAt || 0;
      if (Date.now() - updated > STALE_MS) continue;
      out.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        cwd: raw.cwd,
        name: raw.name || null,
        status: raw.status || 'unknown',
        waitingFor: raw.waitingFor || null,
        startedAt: raw.startedAt || null,
        statusUpdatedAt: raw.statusUpdatedAt || raw.updatedAt || null,
        kind: raw.kind || null,
      });
    } catch {
      /* unreadable/partial file: skip */
    }
  }
  out.sort((a, b) => rank(a) - rank(b) || (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

function rank(s) {
  if (s.status === 'waiting') return 0;
  if (s.status === 'busy') return 1;
  return 2;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

module.exports = { readLiveSessions };
