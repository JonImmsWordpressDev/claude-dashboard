'use strict';
// User configuration: config.json (general), names.json (display names),
// ignore.json (hidden path prefixes). All read fresh-by-mtime and written
// pretty-printed so hand-editing stays pleasant.
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('./paths');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const NAMES_FILE = path.join(ROOT, 'names.json');
const IGNORE_FILE = path.join(ROOT, 'ignore.json');

const DEFAULTS = { terminal: 'ghostty', notifications: true };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readConfig() {
  return { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
}

function updateConfig(patch) {
  const next = { ...readConfig() };
  if (typeof patch.terminal === 'string') next.terminal = patch.terminal;
  if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications;
  writeJson(CONFIG_FILE, next);
  return next;
}

function readNames() {
  return readJson(NAMES_FILE, {});
}

function setName(projectPath, name) {
  const names = readNames();
  const key = canonicalize(projectPath);
  // Stored keys may differ in case from the canonical path — replace any match.
  for (const k of Object.keys(names)) {
    if (canonicalize(k).toLowerCase() === key.toLowerCase()) delete names[k];
  }
  if (name && name.trim()) names[key] = name.trim().slice(0, 80);
  writeJson(NAMES_FILE, names);
}

function readIgnores() {
  const raw = readJson(IGNORE_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function addIgnore(prefix) {
  const list = readIgnores();
  const key = canonicalize(prefix);
  if (!list.some((p) => canonicalize(p).toLowerCase() === key.toLowerCase())) {
    list.push(key);
    writeJson(IGNORE_FILE, list);
  }
}

function removeIgnore(prefix) {
  const key = canonicalize(prefix).toLowerCase();
  writeJson(IGNORE_FILE, readIgnores().filter((p) => canonicalize(p).toLowerCase() !== key));
}

// Terminals we know how to launch, filtered to what's installed.
function detectTerminals() {
  const home = process.env.HOME || '';
  const candidates = [
    { id: 'ghostty', label: 'Ghostty', app: 'Ghostty.app' },
    { id: 'iterm', label: 'iTerm2', app: 'iTerm.app' },
    { id: 'terminal', label: 'Terminal.app', app: null }, // always present on macOS
  ];
  return candidates.filter(
    (c) =>
      !c.app ||
      fs.existsSync(path.join('/Applications', c.app)) ||
      fs.existsSync(path.join(home, 'Applications', c.app))
  );
}

function detectClaudeApp() {
  const home = process.env.HOME || '';
  return (
    fs.existsSync('/Applications/Claude.app') ||
    fs.existsSync(path.join(home, 'Applications', 'Claude.app'))
  );
}

// The terminal that will actually be used: configured if installed, else the
// first installed one.
function resolvedTerminal() {
  const installed = detectTerminals();
  const configured = readConfig().terminal;
  return installed.find((t) => t.id === configured) || installed[0] || { id: 'terminal', label: 'Terminal.app' };
}

module.exports = {
  readConfig,
  detectClaudeApp,
  resolvedTerminal,
  updateConfig,
  readNames,
  setName,
  readIgnores,
  addIgnore,
  removeIgnore,
  detectTerminals,
};
