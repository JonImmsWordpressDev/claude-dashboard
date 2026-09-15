'use strict';
// Files Claude edited in a session, from the file-history records in the
// transcript, plus read-only access to the backups Claude Code keeps under
// ~/.claude/file-history/<sessionId>/. Pure helpers first; fs code below.
const path = require('path');
const fsp = require('fs/promises');
const { CLAUDE_DIR } = require('./paths');
const { diffLines } = require('./diff');

const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
const BACKUP_NAME = /^[0-9a-f]{8,32}@v\d+$/;

// changes: { [realPath]: { versions: [{ v, backup, at }], first, last } }
// `backup` is null only for v1 of a file Claude created (nothing existed
// before it, so there is no pre-edit backup to point at). A null name at any
// other version means the file already has a real earlier backup; ignore it.
function recordChange(changes, realPath, backup) {
  if (!realPath || !backup) return changes;
  const v = Number(backup.version) || 0;
  if (!backup.backupFileName && v !== 1) return changes;
  const at = backup.backupTime ? Date.parse(backup.backupTime) : NaN;
  const e = changes[realPath] || (changes[realPath] = { versions: [], first: null, last: null });
  if (!e.versions.some((x) => x.v === v)) {
    e.versions.push({ v, backup: backup.backupFileName ? String(backup.backupFileName) : null, at: Number.isNaN(at) ? null : at });
    e.versions.sort((x, y) => x.v - y.v);
  }
  if (!Number.isNaN(at)) {
    if (e.first === null || at < e.first) e.first = at;
    if (e.last === null || at > e.last) e.last = at;
  }
  return changes;
}

function mergeChanges(target, src) {
  for (const [p, e] of Object.entries(src || {})) {
    for (const ver of e.versions) {
      recordChange(target, p, { backupFileName: ver.backup, version: ver.v, backupTime: ver.at ? new Date(ver.at).toISOString() : null });
    }
  }
  return target;
}

// Real path for a file-history entry: the key/trackingPath can be an odd
// encoded form, but realParentDir is always the true directory.
function realPathOf(key, backup) {
  if (!backup || !backup.realParentDir || !key) return null;
  return path.join(backup.realParentDir, path.basename(String(key)));
}

const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

function changeFiles(changes) {
  return Object.entries(changes || {})
    .sort((a, b) => (b[1].last || 0) - (a[1].last || 0) || a[0].localeCompare(b[0]))
    .map(([p, e], n) => ({ n, path: p, versions: e.versions, first: e.first, last: e.last }));
}

function relPath(abs, root) {
  const r = String(root || '').replace(/\/+$/, '');
  return r && abs.startsWith(r + '/') ? abs.slice(r.length + 1) : abs;
}

function backupPath(sessionId, backupName) {
  if (!SESSION_ID.test(String(sessionId)) || !BACKUP_NAME.test(String(backupName))) return null;
  return path.join(FILE_HISTORY_DIR, sessionId, backupName);
}

async function defaultRead(abs) {
  try {
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

// A null backup (v1 of a created file) has no file to read: the file didn't
// exist before, so the "original" is the empty string, not a missing read.
async function readVersion(sessionId, file, v, readFile = defaultRead) {
  const ver = file.versions.find((x) => x.v === v);
  if (!ver) return null;
  if (ver.backup === null) return '';
  const p = backupPath(sessionId, ver.backup);
  return p ? readFile(p) : null;
}

async function sessionChangeList({ sessionId, changes, root, readFile = defaultRead }) {
  const files = [];
  for (const f of changeFiles(changes)) {
    const original = await readVersion(sessionId, f, f.versions[0].v, readFile);
    const disk = await readFile(f.path);
    const d = original === null ? { added: 0, removed: 0, tooLarge: false } : diffLines(original, disk || '');
    files.push({
      n: f.n, path: f.path, rel: relPath(f.path, root),
      versions: f.versions.map((x) => x.v), first: f.first, last: f.last,
      exists: disk !== null, missingBackup: original === null,
      added: d.added, removed: d.removed, tooLarge: !!d.tooLarge, truncated: !!d.truncated,
    });
  }
  return { files };
}

// Normalise the `to` side of a diff request: anything that is not a usable
// version number means "the file on disk".
function diffTarget(to) {
  if (to === undefined || to === null || to === 'disk') return 'disk';
  const n = Number(to);
  return Number.isInteger(n) && n > 0 ? n : 'disk';
}

async function sessionFileDiff({ sessionId, changes, n, from, to, root, readFile = defaultRead }) {
  const f = changeFiles(changes)[n];
  if (!f) return null;
  const fromV = Number.isInteger(from) ? from : f.versions[0].v;
  const toV = diffTarget(to);
  const a = await readVersion(sessionId, f, fromV, readFile);
  const b = toV === 'disk' ? (await readFile(f.path)) || '' : await readVersion(sessionId, f, toV, readFile);
  if (a === null || b === null) return { path: f.path, rel: relPath(f.path, root), from: fromV, to: toV, missingBackup: true, hunks: [], added: 0, removed: 0, truncated: false, tooLarge: false };
  return { path: f.path, rel: relPath(f.path, root), from: fromV, to: toV, ...diffLines(a, b) };
}

module.exports = { recordChange, mergeChanges, realPathOf, changeFiles, relPath, backupPath, diffTarget, sessionChangeList, sessionFileDiff };
