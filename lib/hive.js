'use strict';
// Hive view: what each live session is doing right now, and a personality
// earned from how it has behaved so far. Pure functions; the collector
// attaches the results to liveSessions.
const path = require('path');

const TARGET_MAX = 48;

function clip(s, n = TARGET_MAX) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function base(p) {
  return typeof p === 'string' && p ? path.basename(p) : '';
}

function host(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// A tool_use block reduced to "verb target", e.g. editing / server.js.
// Never carries a full path: the card only needs the file name.
function actionOf(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const n = String(name || '');
  switch (n) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'editing', target: clip(base(i.file_path || i.notebook_path)) };
    case 'Write':
      return { verb: 'writing', target: clip(base(i.file_path)) };
    case 'Read':
      return { verb: 'reading', target: clip(base(i.file_path)) };
    case 'Bash':
      return { verb: 'running', target: clip(i.description || i.command) };
    case 'Grep':
      return { verb: 'searching for', target: clip(i.pattern) };
    case 'Glob':
      return { verb: 'looking for', target: clip(i.pattern) };
    case 'WebFetch':
      return { verb: 'reading', target: clip(host(i.url)) };
    case 'WebSearch':
      return { verb: 'searching the web for', target: clip(i.query) };
    case 'Task':
    case 'Agent':
      return { verb: 'briefing an agent', target: clip(i.description) };
    case 'TodoWrite':
      return { verb: 'updating the plan', target: '' };
    case 'AskUserQuestion':
      return { verb: 'asking you a question', target: '' };
    case 'Skill':
      return { verb: 'using skill', target: clip(i.skill) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n);
  if (mcp) return { verb: 'using', target: clip(mcp[1].replace(/^plugin_|^claude_ai_/, '').replace(/_/g, ' ')) };
  return { verb: 'using', target: clip(n) };
}

// Ordered: the first rule a session matches is its personality, unless a
// higher-spending session already took that one, then the next match.
const RULES = [
  { label: 'the overstuffed', test: (s) => s.context && s.context.pct >= 85, why: (s) => `context ${s.context.pct}% full` },
  { label: 'the delegator', test: (s) => s.subagents && s.subagents.count >= 3, why: (s) => `handed work to ${s.subagents.count} subagents` },
  { label: 'the trier', test: (s) => s.tools && s.tools.errors >= 5 && s.tools.errors / s.tools.total >= 0.1, why: (s) => `${s.tools.errors} failed tool calls and still going` },
  { label: 'the big spender', test: (s) => s.burnRate >= 15, why: (s) => `burning $${s.burnRate} an hour` },
  { label: 'the night shift', test: (s) => !!s.background, why: () => 'works in the background' },
  { label: 'the grinder', test: (s) => s.tools && s.tools.total >= 250, why: (s) => `${s.tools.total} tool calls so far` },
  { label: 'the new kid', test: (s, now) => s.startedAt && now - s.startedAt < 15 * 60000, why: () => 'started in the last 15 minutes' },
  { label: 'the frugal one', test: (s) => s.burnRate != null && s.burnRate < 3 && s.tools && s.tools.total >= 20, why: (s) => `only $${s.burnRate} an hour` },
  { label: 'the steady one', test: () => true, why: () => 'nothing unusual, just working' },
];

// Returns sessionId -> { label, why, rank, behind }. Rank is by spend;
// `behind` is the dollar gap to the session one place above.
function hiveRoster(sessions, now = Date.now()) {
  const list = (sessions || []).slice().sort((a, b) => (b.estCost || 0) - (a.estCost || 0));
  const taken = new Set();
  const out = {};
  list.forEach((s, idx) => {
    const matches = RULES.filter((r) => r.test(s, now));
    const pick = matches.find((r) => !taken.has(r.label)) || matches[0];
    taken.add(pick.label);
    const above = idx > 0 ? list[idx - 1].estCost || 0 : null;
    out[s.sessionId] = {
      label: pick.label,
      why: pick.why(s),
      rank: idx + 1,
      behind: above == null ? null : Math.round((above - (s.estCost || 0)) * 100) / 100,
    };
  });
  return out;
}

module.exports = { actionOf, hiveRoster, RULES };
