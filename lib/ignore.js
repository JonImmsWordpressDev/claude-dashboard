'use strict';
// User-editable ignore list: ignore.json is an array of absolute path prefixes.
// A project is hidden if its path equals a prefix or sits anywhere under it.
// Hides from the dashboard only — nothing on disk or in ~/.claude is touched.
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('./paths');

const IGNORE_FILE = path.join(__dirname, '..', 'ignore.json');

let cache = { mtimeMs: 0, prefixes: [] };

function loadIgnores() {
  try {
    const st = fs.statSync(IGNORE_FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8'));
      const prefixes = (Array.isArray(raw) ? raw : [])
        .map((p) => canonicalize(String(p)).toLowerCase())
        .filter(Boolean);
      cache = { mtimeMs: st.mtimeMs, prefixes };
    }
  } catch {
    cache = { mtimeMs: 0, prefixes: [] };
  }
  return cache.prefixes;
}

// Pure prefix matcher (prefixes pre-lowercased) — unit-testable.
function matchesPrefix(projectPath, prefixes) {
  const p = canonicalize(projectPath).toLowerCase();
  for (const prefix of prefixes) {
    if (p === prefix || p.startsWith(prefix + '/')) return true;
  }
  return false;
}

function isIgnored(projectPath) {
  return matchesPrefix(projectPath, loadIgnores());
}

module.exports = { isIgnored, matchesPrefix };
