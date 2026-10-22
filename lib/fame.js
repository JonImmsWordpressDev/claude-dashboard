'use strict';
// Hall of Fame: your best sessions over a period, by award. Pure; the server
// feeds it session summaries plus `git log` commits per project.

const PAD = 5 * 60000; // same padded activity window as cost per commit

// sessionId -> commits made inside its window. A commit inside several
// sessions' windows goes to the one that started most recently, so a long
// resumed session doesn't claim every commit made while it was open.
function commitsBySession(sessions, commitsByProject) {
  const out = new Map();
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.projectPath)) byProject.set(s.projectPath, []);
    byProject.get(s.projectPath).push(s);
  }
  for (const [projectPath, list] of byProject) {
    for (const c of commitsByProject[projectPath] || []) {
      let best = null;
      for (const s of list) {
        if (!s.lastActivityAt) continue;
        const start = (s.startedAt || s.lastActivityAt) - PAD;
        if (c.ts < start || c.ts > s.lastActivityAt + PAD) continue;
        if (!best || (s.startedAt || 0) > (best.startedAt || 0)) best = s;
      }
      if (best) out.set(best.sessionId, (out.get(best.sessionId) || 0) + 1);
    }
  }
  return out;
}

const money = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// Each award: who qualifies, the number it ranks by, and how it reads.
const AWARDS = [
  {
    key: 'shipped', title: 'Most commits shipped', blurb: 'commits made while the session was working',
    ok: (s) => s.commits >= 1, score: (s) => s.commits, label: (s) => plural(s.commits, 'commit'),
  },
  {
    key: 'value', title: 'Best value', blurb: 'lowest cost per commit, three commits or more',
    ok: (s) => s.commits >= 3 && s.cost >= 0.5, score: (s) => -s.cost / s.commits,
    label: (s) => `${money(s.cost / s.commits)} per commit`,
  },
  {
    key: 'grinder', title: 'The grinder', blurb: 'most tool calls in one session',
    ok: (s) => s.tools >= 1, score: (s) => s.tools, label: (s) => plural(s.tools, 'tool call'),
  },
  {
    key: 'clean', title: 'Cleanest run', blurb: 'fewest failed tool calls, fifty calls or more',
    ok: (s) => s.tools >= 50, score: (s) => -(s.errors / s.tools) + s.tools / 1e7,
    label: (s) => `${s.tools} calls, ${s.errors} failed`,
  },
  {
    key: 'delegator', title: 'The delegator', blurb: 'most subagents handed work',
    ok: (s) => s.subagents >= 1, score: (s) => s.subagents, label: (s) => plural(s.subagents, 'subagent'),
  },
  {
    key: 'reach', title: 'Widest reach', blurb: 'most files edited',
    ok: (s) => s.files >= 1, score: (s) => s.files, label: (s) => plural(s.files, 'file') + ' edited',
  },
  {
    key: 'spender', title: 'Big spender', blurb: 'highest list-price value',
    ok: (s) => s.cost >= 0.01, score: (s) => s.cost, label: (s) => money(s.cost),
  },
];

// sessions: [{ sessionId, title, projectName, projectPath, model, cost,
// startedAt, lastActivityAt, tools, errors, subagents, files }]
function hallOfFame(sessions, commitsByProject, { days = 30, now = Date.now(), podium = 3 } = {}) {
  const cut = days ? now - days * 86400000 : 0;
  const inPeriod = (sessions || []).filter((s) => (s.lastActivityAt || 0) >= cut);
  const counts = commitsBySession(inPeriod, commitsByProject || {});
  const rows = inPeriod.map((s) => ({ ...s, commits: counts.get(s.sessionId) || 0 }));
  const awards = [];
  for (const a of AWARDS) {
    const ranked = rows
      .filter(a.ok)
      .sort((x, y) => a.score(y) - a.score(x) || (y.lastActivityAt || 0) - (x.lastActivityAt || 0))
      .slice(0, podium);
    if (!ranked.length) continue;
    awards.push({
      key: a.key,
      title: a.title,
      blurb: a.blurb,
      entries: ranked.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        projectName: s.projectName,
        model: s.model || null,
        label: a.label(s),
        lastActivityAt: s.lastActivityAt,
      })),
    });
  }
  let commits = 0;
  for (const n of counts.values()) commits += n;
  return { days, sessions: rows.length, commits, awards };
}

module.exports = { hallOfFame, commitsBySession, AWARDS };
