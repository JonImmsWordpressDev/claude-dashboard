'use strict';
// Friendly project names: names.json exact match, else a cleaned-up basename.
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('./paths');

const NAMES_FILE = path.join(__dirname, '..', 'names.json');

let cache = { mtimeMs: 0, map: {} };

function loadNames() {
  try {
    const st = fs.statSync(NAMES_FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
      const map = {};
      for (const [k, v] of Object.entries(raw)) map[canonicalize(k).toLowerCase()] = v;
      cache = { mtimeMs: st.mtimeMs, map };
    }
  } catch {
    cache = { mtimeMs: 0, map: {} };
  }
  return cache.map;
}

// Segments that are scaffolding, not identity. Walk up past them so
// "/Users/x/Local Sites/jonimms/app/public" names as "jonimms".
const GENERIC = new Set(['app', 'public', 'wp-content', 'themes', 'plugins', 'src', 'site']);

function displayBase(p) {
  const parts = canonicalize(p).split(path.sep).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!GENERIC.has(parts[i].toLowerCase())) return parts[i];
  }
  return parts[parts.length - 1] || p;
}

function titleCase(s) {
  return s
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (/[A-Z]/.test(w.slice(1)) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function friendlyName(projectPath) {
  const map = loadNames();
  const hit = map[canonicalize(projectPath).toLowerCase()];
  if (hit) return hit;
  return titleCase(displayBase(projectPath));
}

module.exports = { friendlyName, displayBase, titleCase };
