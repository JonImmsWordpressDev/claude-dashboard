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
function parseSearchQuery(q, now = Date.now()) {
  let project = null;
  let since = null;
  const text = String(q)
    .replace(/(?:^|\s)project:(\S+)/i, (_, v) => { project = v.toLowerCase(); return ' '; })
    .replace(/(?:^|\s)since:(\S+)/i, (_, v) => {
      const rel = /^(\d+)d$/i.exec(v);
      const abs = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (rel) since = now - Number(rel[1]) * 86400000;
      else if (abs) since = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])).getTime();
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, project, since };
}

function searchHistory(q) {
  const { text, project, since } = parseSearchQuery(q);
  const needle = text.toLowerCase();
  return new Promise((resolve) => {
    const matches = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(HISTORY_FILE, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.toLowerCase().includes(needle)) return;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.display !== 'string' || !rec.display.toLowerCase().includes(needle)) return;
        const { root } = worktreeRoot(rec.project || '');
        if (isIgnored(root)) return;
        if (project && !root.toLowerCase().includes(project)) return;
        if (since && !(rec.timestamp >= since)) return;
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
  const { text, project, since } = parseSearchQuery(q);
  const needle = text.toLowerCase();
  const out = [];
  for (const g of transcriptGroups.values()) {
    if (isIgnored(g.path)) continue;
    if (project && !g.path.toLowerCase().includes(project)) continue;
    for (const m of g.sessions) {
      if (since && !(m.lastActivityAt >= since)) continue;
      const { title } = sessionTitle(m);
      if (title && title.toLowerCase().includes(needle)) {
        out.push({ title, project: g.path, sessionId: m.sessionId, lastActivityAt: m.lastActivityAt });
      }
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out.slice(0, MAX_RESULTS);
}

module.exports = { searchHistory, searchTitles, parseSearchQuery };
