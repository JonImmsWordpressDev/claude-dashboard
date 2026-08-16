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

module.exports = { parseGitLog, linkCommitsToSessions, recentCommits };
