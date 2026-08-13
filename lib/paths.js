'use strict';
// Shared path helpers: canonicalization, worktree grouping, project-dir encoding.
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

function canonicalize(p) {
  if (!p) return p;
  let r = path.resolve(p);
  if (r.length > 1 && r.endsWith(path.sep)) r = r.slice(0, -1);
  return r;
}

// A session run inside `<repo>/.claude/worktrees/<name>` belongs to <repo>.
// Returns { root, worktree } where worktree is the worktree folder name or null.
function worktreeRoot(p) {
  const c = canonicalize(p);
  const m = c.match(/^(.*)\/\.claude\/worktrees\/([^/]+)$/);
  if (m) return { root: m[1], worktree: m[2] };
  return { root: c, worktree: null };
}

// Encode a real path the way ~/.claude/projects dir names are built.
// Forward-only (real path -> encoded); never decode, the mapping is lossy.
function encodeProjectDir(p) {
  return canonicalize(p).replace(/[/. ]/g, '-');
}

module.exports = { CLAUDE_DIR, canonicalize, worktreeRoot, encodeProjectDir };
