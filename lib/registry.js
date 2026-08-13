'use strict';
// Project registry from ~/.claude.json `projects` map, with worktree-root
// normalization and case-insensitive dedupe (APFS is case-insensitive; the
// registry really does contain e.g. both "Projects/" and "projects/" variants).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalize, worktreeRoot } = require('./paths');

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

let cache = { mtimeMs: 0, projects: new Map() };

// Returns Map<lowercasePath, {path, lastSessionId, lastSessionModified,
//   lastStartTime, lastSessionFirstPrompt, lastCost}>
function readRegistry() {
  let st;
  try {
    st = fs.statSync(CLAUDE_JSON);
  } catch {
    return new Map();
  }
  if (st.mtimeMs === cache.mtimeMs) return cache.projects;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
  } catch {
    return cache.projects; // keep last good copy on parse failure (mid-write)
  }

  const merged = new Map();
  for (const [rawPath, info] of Object.entries(data.projects || {})) {
    const { root } = worktreeRoot(canonicalize(rawPath));
    const key = root.toLowerCase();
    const entry = merged.get(key) || { path: root, exists: null };
    const modified = info.lastSessionModified || info.lastStartTime || 0;
    const prevModified = entry.lastSessionModified || entry.lastStartTime || 0;
    // Newest-activity variant wins for both metadata and display casing.
    if (!merged.has(key) || modified >= prevModified) {
      entry.path = pickExistingCasing(entry.path, root);
      if (info.lastSessionId) entry.lastSessionId = info.lastSessionId;
      if (modified) entry.lastSessionModified = modified;
      if (info.lastStartTime) entry.lastStartTime = info.lastStartTime;
      if (info.lastSessionFirstPrompt) entry.lastSessionFirstPrompt = info.lastSessionFirstPrompt;
      if (typeof info.lastCost === 'number') entry.lastCost = info.lastCost;
    }
    merged.set(key, entry);
  }
  cache = { mtimeMs: st.mtimeMs, projects: merged };
  return merged;
}

function pickExistingCasing(a, b) {
  if (!a) return b;
  if (a === b) return a;
  // Prefer the variant that exists on disk with that exact casing.
  for (const cand of [b, a]) {
    try {
      const real = fs.realpathSync.native(cand);
      if (path.basename(real) === path.basename(cand)) return cand;
    } catch {
      /* missing path, try next */
    }
  }
  return b;
}

module.exports = { readRegistry };
