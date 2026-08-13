'use strict';
// Shared path helpers: canonicalization, worktree grouping, project-dir encoding.
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Canonical form used for all internal keys and comparisons: resolved,
// forward slashes on every platform (Windows paths become C:/Users/...),
// no trailing slash. Display strings keep whatever the source gave us.
function canonicalize(p) {
  if (!p) return p;
  // Don't run path.resolve on a Windows-style path when we're not on Windows
  // (it would prefix the posix cwd) — those appear in tests and in data
  // copied between machines.
  const winStyle = /^[A-Za-z]:[\\/]/.test(p);
  let r = winStyle && process.platform !== 'win32' ? p : path.resolve(p);
  r = r.replace(/\\/g, '/');
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
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
// Windows drive colons become dashes too (best guess — unverified on Windows).
function encodeProjectDir(p) {
  return canonicalize(p).replace(/[/:. ]/g, '-');
}

module.exports = { CLAUDE_DIR, canonicalize, worktreeRoot, encodeProjectDir };
