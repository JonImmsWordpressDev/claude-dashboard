'use strict';
// Search across every prompt ever sent (history.jsonl) and session titles.
// Reads history on demand — it's under 1MB and a search is a click.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { CLAUDE_DIR, worktreeRoot } = require('./paths');
const { isIgnored } = require('./ignore');

const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const MAX_RESULTS = 60;

// 'project:dashboard since:7d fix the build' -> filters plus remaining text.
// project: substring-matches the canonical project path; since: takes Nd or
// YYYY-MM-DD (local). Malformed values are dropped rather than erroring.
// m:/model:, b:/branch: and file: are session filters: substring matches on
// any model the session used, the branch it started on, and the paths of the
// files it changed.
function parseSearchQuery(q, now = Date.now()) {
  let project = null;
  let since = null;
  let model = null;
  let branch = null;
  let file = null;
  const text = String(q)
    .replace(/(?:^|\s)project:(\S+)/i, (_, v) => { project = v.toLowerCase(); return ' '; })
    .replace(/(?:^|\s)(?:m|model):(\S+)/i, (_, v) => { model = v.toLowerCase(); return ' '; })
    .replace(/(?:^|\s)(?:b|branch):(\S+)/i, (_, v) => { branch = v.toLowerCase(); return ' '; })
    .replace(/(?:^|\s)file:(\S+)/i, (_, v) => { file = v.toLowerCase(); return ' '; })
    .replace(/(?:^|\s)since:(\S+)/i, (_, v) => {
      const rel = /^(\d+)d$/i.exec(v);
      const abs = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (rel) since = now - Number(rel[1]) * 86400000;
      else if (abs) since = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])).getTime();
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, project, since, model, branch, file };
}

const hasSessionFilters = (f) => Boolean(f.model || f.branch || f.file);

// A session's transcript meta against the session filters. A filter the
// session has no data for (no branch, no changes) fails rather than passes.
function sessionMatchesFilters(meta, f) {
  if (f.model) {
    const models = [meta.model, ...Object.keys(meta.usage || {})].filter(Boolean);
    if (!models.some((m) => m.toLowerCase().includes(f.model))) return false;
  }
  if (f.branch && !(meta.gitBranch || '').toLowerCase().includes(f.branch)) return false;
  if (f.file && !Object.keys(meta.changes || {}).some((p) => p.toLowerCase().includes(f.file))) return false;
  return true;
}

// For sources keyed only by session id (history.jsonl): a predicate over the
// ids of sessions passing the filters, or null when there are none to apply.
function sessionFilterFor(q, transcriptGroups) {
  const f = parseSearchQuery(q);
  if (!hasSessionFilters(f)) return null;
  const ok = new Set();
  for (const g of transcriptGroups.values()) {
    for (const m of g.sessions) if (sessionMatchesFilters(m, f)) ok.add(m.sessionId);
  }
  return (id) => Boolean(id) && ok.has(id);
}

// The needle as it appears inside a raw JSON line: a typed " or \ is stored
// escaped, so the cheap pre-filter must look for the escaped form.
const rawNeedle = (needle) => JSON.stringify(needle).slice(1, -1).toLowerCase();

function searchHistory(q, { allowSession = null, file = HISTORY_FILE } = {}) {
  const { text, project, since } = parseSearchQuery(q);
  const needle = text.toLowerCase();
  const raw = rawNeedle(needle);
  return new Promise((resolve) => {
    const matches = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.toLowerCase().includes(raw)) return;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.display !== 'string' || !rec.display.toLowerCase().includes(needle)) return;
        const { root } = worktreeRoot(rec.project || '');
        if (isIgnored(root)) return;
        if (project && !root.toLowerCase().includes(project)) return;
        if (since && !(rec.timestamp >= since)) return;
        if (allowSession && !allowSession(rec.sessionId)) return;
        const i = rec.display.toLowerCase().indexOf(needle);
        const start = Math.max(0, i - 60);
        matches.push({
          snippet: (start > 0 ? '…' : '') + rec.display.slice(start, i + needle.length + 120).replace(/\s+/g, ' '),
          project: root,
          timestamp: rec.timestamp || null,
          sessionId: rec.sessionId || null,
        });
      } catch {
        /* skip */
      }
    });
    const done = () => {
      matches.reverse(); // newest first
      resolve(matches.slice(0, MAX_RESULTS));
    };
    rl.on('close', done);
    rl.on('error', done);
  });
}

// Title matches come from the collector's in-memory transcript groups.
function searchTitles(q, transcriptGroups, sessionTitle) {
  const f = parseSearchQuery(q);
  const { text, project, since } = f;
  const needle = text.toLowerCase();
  const out = [];
  for (const g of transcriptGroups.values()) {
    if (isIgnored(g.path)) continue;
    if (project && !g.path.toLowerCase().includes(project)) continue;
    for (const m of g.sessions) {
      if (since && !(m.lastActivityAt >= since)) continue;
      if (!sessionMatchesFilters(m, f)) continue;
      const { title } = sessionTitle(m);
      if (title && title.toLowerCase().includes(needle)) {
        out.push({ title, project: g.path, sessionId: m.sessionId, lastActivityAt: m.lastActivityAt });
      }
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out.slice(0, MAX_RESULTS);
}

// Notes the user attached to sessions (config.json sessionNotes).
function searchNotes(q, transcriptGroups, sessionNotes, now = Date.now()) {
  const f = parseSearchQuery(q, now);
  const { text, project, since } = f;
  const needle = text.toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const g of transcriptGroups.values()) {
    if (isIgnored(g.path)) continue;
    if (project && !g.path.toLowerCase().includes(project)) continue;
    for (const m of g.sessions) {
      const raw = sessionNotes && sessionNotes[m.sessionId];
      const note = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
      if (!note || !note.toLowerCase().includes(needle)) continue;
      if (since && !(m.lastActivityAt >= since)) continue;
      if (!sessionMatchesFilters(m, f)) continue;
      const i = note.toLowerCase().indexOf(needle);
      const start = Math.max(0, i - 60);
      out.push({
        note,
        snippet: (start > 0 ? '…' : '') + note.slice(start, i + needle.length + 120).replace(/\s+/g, ' '),
        project: g.path,
        sessionId: m.sessionId,
        lastActivityAt: m.lastActivityAt,
      });
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out.slice(0, MAX_RESULTS);
}

// One transcript line against a lowercase needle -> {role, text, ts} | null.
// Only real conversation text counts: tool results and harness noise don't.
function transcriptLineMatch(line, needle) {
  if (!line.toLowerCase().includes(rawNeedle(needle))) return null;
  if (line.includes('"tool_use_id"')) return null;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  const m = rec.message;
  if (!m || (rec.type !== 'user' && rec.type !== 'assistant')) return null;
  let text = null;
  const c = m.content;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const part = c.find((x) => x && x.type === 'text' && x.text && x.text.toLowerCase().includes(needle));
    text = part && part.text;
  }
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('<') || t.startsWith('[SYSTEM') || t.startsWith('Caveat:') || t.startsWith('Base directory')) return null;
  const i = t.toLowerCase().indexOf(needle);
  if (i === -1) return null;
  const start = Math.max(0, i - 60);
  return {
    role: rec.type === 'user' ? 'you' : 'claude',
    text: (start > 0 ? '…' : '') + t.slice(start, i + needle.length + 140).replace(/\s+/g, ' '),
    ts: rec.timestamp ? Date.parse(rec.timestamp) || null : null,
  };
}

// Stream-search full transcripts, newest sessions first. No index, no cache:
// ~200MB greps in a couple of seconds, and the result reports its coverage.
const MAX_DEEP_RESULTS = 40;
const MAX_PER_SESSION = 3;

async function searchTranscripts(q, transcriptGroups) {
  const f = parseSearchQuery(q);
  const { text, project, since } = f;
  const needle = text.toLowerCase();
  if (!needle) return { matches: [], scanned: 0, total: 0, complete: true };
  const sessions = [];
  for (const g of transcriptGroups.values()) {
    if (isIgnored(g.path)) continue;
    if (project && !g.path.toLowerCase().includes(project)) continue;
    for (const m of g.sessions) {
      if (since && !(m.lastActivityAt >= since)) continue;
      if (!sessionMatchesFilters(m, f)) continue;
      sessions.push({ file: m.file, sessionId: m.sessionId, project: g.path, lastActivityAt: m.lastActivityAt });
    }
  }
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const matches = [];
  let scanned = 0;
  for (const s of sessions) {
    if (matches.length >= MAX_DEEP_RESULTS) break;
    scanned++;
    await new Promise((resolve) => {
      let found = 0;
      const rl = readline.createInterface({
        input: fs.createReadStream(s.file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      rl.on('line', (line) => {
        if (matches.length >= MAX_DEEP_RESULTS || found >= MAX_PER_SESSION) return;
        const hit = transcriptLineMatch(line, needle);
        if (hit) {
          found++;
          matches.push({ ...hit, sessionId: s.sessionId, project: s.project });
        }
      });
      rl.on('close', resolve);
      rl.on('error', resolve);
    });
  }
  return { matches, scanned, total: sessions.length, complete: scanned >= sessions.length };
}

module.exports = {
  searchHistory, searchTitles, searchNotes, parseSearchQuery, transcriptLineMatch, searchTranscripts,
  sessionMatchesFilters, sessionFilterFor,
};
