'use strict';
// Recent commits for the project drawer — read-only `git log`, execFile
// arg arrays only (paths contain spaces).
const { execFile } = require('child_process');

// %x1e opens each record, %x1f separates fields:
// sha, committer epoch, subject, author, Co-Authored-By trailer values.
const FMT = '%x1e%h%x1f%ct%x1f%s%x1f%an%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x20)';

function parseGitLog(raw) {
  const out = [];
  for (const rec of String(raw).split('\x1e')) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n');
    const head = nl === -1 ? rec : rec.slice(0, nl);
    const rest = nl === -1 ? '' : rec.slice(nl + 1);
    const [sha, ct, subject, author, coauthors] = head.split('\x1f');
    if (!sha) continue;
    const statLine = rest
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /files? changed/.test(l));
    out.push({
      sha,
      ts: (Number(ct) || 0) * 1000,
      subject: subject || '',
      author: author || '',
      claude: /claude/i.test(coauthors || ''),
      stat: statLine || null,
    });
  }
  return out;
}

// A Claude commit made while a session was active in the same repo probably
// came from that session — honest heuristic, windows padded 5 minutes.
const PAD = 5 * 60000;
function linkCommitsToSessions(commits, sessions) {
  return commits.map((c) => {
    const s = (sessions || []).find(
      (x) => c.ts >= ((x.startedAt || x.lastActivityAt) - PAD) && c.ts <= (x.lastActivityAt + PAD)
    );
    return s ? { ...c, sessionId: s.sessionId, sessionTitle: s.title } : c;
  });
}

// Cost per commit: each session's cost is split evenly across the commits
// made inside its activity window (same padded window as above). A commit
// inside two overlapping sessions gets a share of both. Sessions that cost
// something but committed nothing, since the oldest listed commit, are
// reported separately rather than spread over unrelated commits.
const round2 = (n) => Math.round(n * 100) / 100;
function commitCosts(commits, sessions) {
  const cost = new Map(); // sha -> usd
  const from = new Map(); // sha -> [{ sessionId, title, commits }]
  const oldest = commits.length ? Math.min(...commits.map((c) => c.ts)) : Infinity;
  let attributed = 0;
  let noCommit = 0;
  for (const s of sessions || []) {
    const usd = s.estCost || 0;
    if (usd < 0.005 || !s.lastActivityAt) continue;
    const start = (s.startedAt || s.lastActivityAt) - PAD;
    const end = s.lastActivityAt + PAD;
    const inside = commits.filter((c) => c.ts >= start && c.ts <= end);
    if (!inside.length) {
      if (s.lastActivityAt >= oldest) noCommit += usd;
      continue;
    }
    attributed += usd;
    for (const c of inside) {
      cost.set(c.sha, (cost.get(c.sha) || 0) + usd / inside.length);
      from.set(c.sha, [...(from.get(c.sha) || []), { sessionId: s.sessionId, title: s.title || null, commits: inside.length }]);
    }
  }
  const out = commits.map((c) => (cost.has(c.sha) ? { ...c, cost: round2(cost.get(c.sha)), costFrom: from.get(c.sha) } : c));
  const withSession = cost.size;
  return {
    commits: out,
    summary: {
      total: commits.length,
      withSession,
      perCommit: withSession ? round2(attributed / withSession) : null,
      noCommitSpend: round2(noCommit),
    },
  };
}

function recentCommits(projectPath, limit = 30) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', projectPath, 'log', `--format=${FMT}`, '--shortstat', '-n', String(limit)],
      { timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parseGitLog(stdout))
    );
  });
}

module.exports = { parseGitLog, linkCommitsToSessions, commitCosts, recentCommits };
