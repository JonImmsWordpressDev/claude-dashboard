'use strict';
// User configuration: config.json (general), names.json (display names),
// ignore.json (hidden path prefixes). All read fresh-by-mtime and written
// pretty-printed so hand-editing stays pleasant.
const fs = require('fs');
const path = require('path');
const { canonicalize, managedSettingsPath } = require('./paths');
const { loadPricing } = require('./pricing');

const ROOT = path.join(__dirname, '..');

// Every user file the dashboard keeps. All live in one directory.
const USER_FILES = ['config.json', 'names.json', 'ignore.json', 'chats.json'];

// Pure: where user files live. CLAUDE_DASH_CONFIG_DIR wins. A writable git
// checkout keeps them beside the code (the original layout; they're
// gitignored). Anything else — a global npm install, the npx cache, brew, an
// unpacked zip — is a tree a package manager or the self-updater may
// replace wholesale, so user data goes to ~/.config/claude-dashboard.
function chooseConfigDir({ env, rootIsGit, rootWritable, root, home }) {
  if (env) return { dir: env, migrateFrom: null };
  if (rootIsGit && rootWritable) return { dir: root, migrateFrom: null };
  return { dir: path.join(home, '.config', 'claude-dashboard'), migrateFrom: root };
}

function resolveConfigDir() {
  let rootWritable = true;
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
  } catch {
    rootWritable = false;
  }
  const { dir, migrateFrom } = chooseConfigDir({
    env: process.env.CLAUDE_DASH_CONFIG_DIR,
    rootIsGit: fs.existsSync(path.join(ROOT, '.git')),
    rootWritable,
    root: ROOT,
    home: require('os').homedir(),
  });
  fs.mkdirSync(dir, { recursive: true });
  // Older versions wrote user files into the package dir even for npm
  // installs. Copy (never move) any that aren't in the new home yet, so the
  // first run on this version keeps names, notes, pins and the phone key.
  if (migrateFrom) {
    for (const f of USER_FILES) {
      const from = path.join(migrateFrom, f);
      const to = path.join(dir, f);
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
      } catch { /* unreadable old file: start fresh rather than fail to boot */ }
    }
  }
  return dir;
}
const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const NAMES_FILE = path.join(CONFIG_DIR, 'names.json');
const IGNORE_FILE = path.join(CONFIG_DIR, 'ignore.json');

const DEFAULTS = { terminal: 'ghostty', notifications: true, usageApi: true, mutedProjects: [], weeklyBudget: 0, pinnedSessions: [], sessionNames: {}, sessionNotes: {}, idleNagMinutes: 60, endOfDayDigest: '', theme: 'board', remoteEnabled: false, remoteMode: 'lan' };

// The one theme list: updateConfig validates against it and GET /api/config
// serves it, so the settings dropdown can never offer a value the server
// would drop. Adding a theme = one entry here + its CSS block in index.html.
const THEMES = [
  { id: 'board', label: 'Departures board' },
  { id: 'phosphor', label: 'Phosphor' },
  { id: 'amber', label: 'Amber CRT' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'newsprint', label: 'Newsprint' },
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// For read-modify-write paths. A missing file is a fresh start; a file that
// exists but won't parse (hand-edit typo, partial write from an older
// version) must NOT be treated as empty — writing back would wipe every
// name, note, pin and the phone key. Refuse, and say which file.
function readJsonForWrite(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON; fix or remove ${file} and try again`);
  }
}

// Atomic: write a sibling temp file, then rename over the target. A crash
// or full disk mid-write leaves the old file intact instead of truncated.
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

function readConfig() {
  return { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
}

function readConfigForWrite() {
  return { ...DEFAULTS, ...readJsonForWrite(CONFIG_FILE, {}) };
}

// Rate table: Claude Code's managed `modelPricing` first (contracted rates
// an admin deployed), then the same key in our config.json, then bundled
// list prices. Both files are small; read fresh every call like readConfig.
function readPricing() {
  const managed = readJson(managedSettingsPath(), null);
  return loadPricing(managed && managed.modelPricing, readConfig().modelPricing);
}

function updateConfig(patch) {
  const next = readConfigForWrite();
  if (typeof patch.terminal === 'string') next.terminal = patch.terminal;
  if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications;
  if (typeof patch.usageApi === 'boolean') next.usageApi = patch.usageApi;
  if (typeof patch.weeklyBudget === 'number' && patch.weeklyBudget >= 0 && Number.isFinite(patch.weeklyBudget)) {
    next.weeklyBudget = Math.round(patch.weeklyBudget);
  }
  if (typeof patch.idleNagMinutes === 'number' && patch.idleNagMinutes >= 0 && Number.isFinite(patch.idleNagMinutes)) {
    next.idleNagMinutes = Math.round(patch.idleNagMinutes);
  }
  if (typeof patch.endOfDayDigest === 'string') {
    const v = patch.endOfDayDigest.trim();
    if (v === '' || require('./notify').parseDigestTime(v) !== null) next.endOfDayDigest = v;
  }
  if (THEMES.some((t) => t.id === patch.theme)) next.theme = patch.theme;
  // Phone view: turning it on mints a pairing key; rotating replaces it, so
  // every link handed out before stops working.
  if (typeof patch.remoteEnabled === 'boolean') next.remoteEnabled = patch.remoteEnabled;
  if (patch.remoteMode === 'lan' || patch.remoteMode === 'tailscale') next.remoteMode = patch.remoteMode;
  if (patch.rotateRemoteKey === true || (next.remoteEnabled && !next.remoteKey)) {
    next.remoteKey = require('crypto').randomBytes(24).toString('base64url');
  }
  writeJson(CONFIG_FILE, next);
  return next;
}

// Add or remove a project from the notification mute list.
function setProjectMuted(projectPath, muted) {
  const next = readConfigForWrite();
  const key = canonicalize(projectPath);
  const list = (next.mutedProjects || []).filter((p) => canonicalize(p).toLowerCase() !== key.toLowerCase());
  if (muted) list.push(key);
  next.mutedProjects = list;
  writeJson(CONFIG_FILE, next);
  return next;
}

// Pin or unpin a session for the pinned strip. Returns the new pinned state.
function togglePin(sessionId) {
  const next = readConfigForWrite();
  const list = next.pinnedSessions || [];
  const has = list.includes(sessionId);
  next.pinnedSessions = has ? list.filter((id) => id !== sessionId) : [...list, sessionId];
  writeJson(CONFIG_FILE, next);
  return !has;
}

// Pure: returns a new sessionNames map with `name` set for `sessionId`
// (trimmed, capped at 80 chars); an empty name removes the entry.
function applySessionName(sessionNames, sessionId, name) {
  const next = { ...(sessionNames || {}) };
  const clean = String(name || '').trim().slice(0, 80);
  if (clean) next[sessionId] = clean;
  else delete next[sessionId];
  return next;
}

function setSessionName(sessionId, name) {
  const next = readConfigForWrite();
  next.sessionNames = applySessionName(next.sessionNames, sessionId, name);
  writeJson(CONFIG_FILE, next);
  return next.sessionNames[sessionId] || '';
}

// Pure: returns a new sessionNotes map with `note` set for `sessionId`
// (trimmed, capped at 2000 chars); an empty note removes the entry.
const NOTE_CAP = 2000;
function applySessionNote(sessionNotes, sessionId, note) {
  const next = { ...(sessionNotes || {}) };
  const clean = String(note || '').trim().slice(0, NOTE_CAP);
  if (clean) next[sessionId] = clean;
  else delete next[sessionId];
  return next;
}

function setSessionNote(sessionId, note) {
  const next = readConfigForWrite();
  next.sessionNotes = applySessionNote(next.sessionNotes, sessionId, note);
  writeJson(CONFIG_FILE, next);
  return next.sessionNotes[sessionId] || '';
}

function readNames() {
  return readJson(NAMES_FILE, {});
}

function setName(projectPath, name) {
  const names = readJsonForWrite(NAMES_FILE, {});
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
  const raw = readJsonForWrite(IGNORE_FILE, []);
  const list = Array.isArray(raw) ? raw : [];
  const key = canonicalize(prefix);
  if (!list.some((p) => canonicalize(p).toLowerCase() === key.toLowerCase())) {
    list.push(key);
    writeJson(IGNORE_FILE, list);
  }
}

function removeIgnore(prefix) {
  const key = canonicalize(prefix).toLowerCase();
  const raw = readJsonForWrite(IGNORE_FILE, []);
  writeJson(IGNORE_FILE, (Array.isArray(raw) ? raw : []).filter((p) => canonicalize(p).toLowerCase() !== key));
}

// Walk PATH for a binary; `exists` injected so the walk is unit-testable.
// Linux-only (detectTerminals), so PATH is ':'-separated with posix joins.
function findOnPath(name, pathEnv = process.env.PATH || '', exists = fs.existsSync) {
  for (const dir of String(pathEnv).split(':')) {
    if (!dir) continue;
    const p = path.posix.join(dir, name);
    if (exists(p)) return p;
  }
  return null;
}

const LINUX_TERMINALS = [
  { id: 'kitty', label: 'kitty' },
  { id: 'alacritty', label: 'Alacritty' },
  { id: 'gnome-terminal', label: 'GNOME Terminal' },
  { id: 'konsole', label: 'Konsole' },
  { id: 'xterm', label: 'xterm' },
];

// Terminals we know how to launch, filtered to what's installed.
function detectTerminals() {
  if (process.platform === 'linux') {
    return LINUX_TERMINALS.filter((t) => findOnPath(t.id));
  }
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
  THEMES,
  readConfig,
  readPricing,
  configDir: () => CONFIG_DIR,
  chooseConfigDir,
  writeJson,
  readJsonForWrite,
  findOnPath,
  detectClaudeApp,
  resolvedTerminal,
  updateConfig,
  setProjectMuted,
  togglePin,
  applySessionName,
  setSessionName,
  applySessionNote,
  setSessionNote,
  readNames,
  setName,
  readIgnores,
  addIgnore,
  removeIgnore,
  detectTerminals,
};
