'use strict';
// Incremental reader for ~/.claude/history.jsonl (append-only prompt log).
// Keeps per-project timestamps (90 days) + total counts in memory.
const fs = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR, worktreeRoot } = require('./paths');

const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

const state = {
  offset: 0,
  partial: '',
  // lowercaseProjectPath -> { timestamps: number[], promptCount, lastPrompt, lastTimestamp }
  byProject: new Map(),
};

async function refreshHistory() {
  let st;
  try {
    st = await fs.stat(HISTORY_FILE);
  } catch {
    return state.byProject;
  }
  if (st.size < state.offset) {
    // truncated/rotated: start over
    state.offset = 0;
    state.partial = '';
    state.byProject.clear();
  }
  if (st.size === state.offset) return state.byProject;

  const fh = await fs.open(HISTORY_FILE, 'r');
  try {
    const len = st.size - state.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, state.offset);
    state.offset = st.size;
    const text = state.partial + buf.toString('utf8');
    const lines = text.split('\n');
    state.partial = lines.pop() || ''; // last element may be a partial line
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec.project || !rec.timestamp) continue;
      const { root } = worktreeRoot(rec.project);
      const key = root.toLowerCase();
      let e = state.byProject.get(key);
      if (!e) {
        e = { path: root, timestamps: [], promptCount: 0, lastPrompt: null, lastTimestamp: 0 };
        state.byProject.set(key, e);
      }
      e.promptCount++;
      if (rec.timestamp >= e.lastTimestamp) {
        e.lastTimestamp = rec.timestamp;
        e.lastPrompt = typeof rec.display === 'string' ? rec.display.slice(0, 200) : null;
      }
      if (Date.now() - rec.timestamp < KEEP_MS) e.timestamps.push(rec.timestamp);
    }
  } finally {
    await fh.close();
  }
  // prune old timestamps occasionally
  const cutoff = Date.now() - KEEP_MS;
  for (const e of state.byProject.values()) {
    if (e.timestamps.length && e.timestamps[0] < cutoff) {
      e.timestamps = e.timestamps.filter((t) => t >= cutoff);
    }
  }
  return state.byProject;
}

// Daily prompt counts for the last `days` local days, oldest -> newest.
function activityBuckets(timestamps, days = 14) {
  const counts = new Array(days).fill(0);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();
  const DAY = 24 * 60 * 60 * 1000;
  for (const t of timestamps) {
    const daysAgo = t >= todayStart ? 0 : Math.ceil((todayStart - t) / DAY);
    const slot = days - 1 - daysAgo;
    if (slot >= 0 && slot < days) counts[slot]++;
  }
  return counts;
}

module.exports = { refreshHistory, activityBuckets };
