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

function searchHistory(q) {
  const needle = q.toLowerCase();
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
  const needle = q.toLowerCase();
  const out = [];
  for (const g of transcriptGroups.values()) {
    if (isIgnored(g.path)) continue;
    for (const m of g.sessions) {
      const { title } = sessionTitle(m);
      if (title && title.toLowerCase().includes(needle)) {
        out.push({ title, project: g.path, sessionId: m.sessionId, lastActivityAt: m.lastActivityAt });
      }
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out.slice(0, MAX_RESULTS);
}

module.exports = { searchHistory, searchTitles };
