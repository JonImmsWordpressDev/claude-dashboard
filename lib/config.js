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

const DEFAULTS = { terminal: 'ghostty', notifications: true, usageApi: true, mutedProjects: [], weeklyBudget: 0, pinnedSessions: [] };

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
  if (typeof patch.usageApi === 'boolean') next.usageApi = patch.usageApi;
  if (typeof patch.weeklyBudget === 'number' && patch.weeklyBudget >= 0 && Number.isFinite(patch.weeklyBudget)) {
    next.weeklyBudget = Math.round(patch.weeklyBudget);
  }
  writeJson(CONFIG_FILE, next);
  return next;
}

// Add or remove a project from the notification mute list.
function setProjectMuted(projectPath, muted) {
  const next = { ...readConfig() };
  const key = canonicalize(projectPath);
  const list = (next.mutedProjects || []).filter((p) => canonicalize(p).toLowerCase() !== key.toLowerCase());
  if (muted) list.push(key);
  next.mutedProjects = list;
  writeJson(CONFIG_FILE, next);
  return next;
}

// Pin or unpin a session for the pinned strip. Returns the new pinned state.
function togglePin(sessionId) {
  const next = { ...readConfig() };
  const list = next.pinnedSessions || [];
  const has = list.includes(sessionId);
  next.pinnedSessions = has ? list.filter((id) => id !== sessionId) : [...list, sessionId];
  writeJson(CONFIG_FILE, next);
  return !has;
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
  if (process.platform === 'win32') {
    const wtPath = path.join(
      process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe'
    );
    const out = [];
    if (fs.existsSync(wtPath)) out.push({ id: 'wt', label: 'Windows Terminal' });
    out.push({ id: 'powershell', label: 'PowerShell' });
    out.push({ id: 'cmd', label: 'Command Prompt' });
    return out;
  }
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
  if (process.platform === 'win32') {
    return fs.existsSync(
      path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude')
    );
  }
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
  setProjectMuted,
  togglePin,
  readNames,
  setName,
  readIgnores,
  addIgnore,
  removeIgnore,
  detectTerminals,
};
