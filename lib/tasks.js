'use strict';
// Todo lists for live sessions: ~/.claude/tasks/<sessionId>/<n>.json
const fs = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

// cache: sessionId -> { mtimeMs, result }
const cache = new Map();

async function readTasks(sessionId) {
  if (!sessionId) return null;
  const dir = path.join(TASKS_DIR, sessionId);
  let st;
  try {
    st = await fs.stat(dir);
  } catch {
    return null;
  }
  const hit = cache.get(sessionId);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.result;

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }
  const tasks = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      tasks.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
    } catch {
      /* skip partial writes */
    }
  }
  if (!tasks.length) return null;
  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  const current = tasks.find((t) => t.status === 'in_progress') || null;
  const result = {
    currentTask: current ? { subject: current.subject, activeForm: current.activeForm || current.subject } : null,
    tasksSummary: {
      completed: tasks.filter((t) => t.status === 'completed').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
    },
  };
  cache.set(sessionId, { mtimeMs: st.mtimeMs, result });
  return result;
}

module.exports = { readTasks };
