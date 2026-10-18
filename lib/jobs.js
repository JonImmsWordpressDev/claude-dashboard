'use strict';
// Background sessions (`claude --bg`, Agent View) from ~/.claude/jobs/<id>/
// state.json: Agent View's name and one-line summary, the job's state, and
// its worktree. The files outlive the session, so finished jobs show too.
//
// For a job whose worktree still exists we also count work that would be
// lost if the session were deleted from Agent View's list, which discards
// the worktree: uncommitted files, and commits on no other branch or remote.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { CLAUDE_DIR } = require('./paths');
const { parsePorcelainV2 } = require('./gitstatus');

const JOBS_DIR = path.join(CLAUDE_DIR, 'jobs');
const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // finished jobs older than this drop off
const MAX_JOBS = 30;

const cache = new Map(); // jobId -> { mtimeMs, job }

function ms(v) {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function normalizeJob(jobId, raw) {
  if (!raw || !raw.sessionId) return null;
  return {
    jobId,
    sessionId: raw.sessionId,
    name: raw.name || null,
    state: raw.state || null,
    detail: raw.detail ? String(raw.detail).slice(0, 200) : null,
    intent: raw.intent ? String(raw.intent).slice(0, 200) : null,
    cwd: raw.cwd || null,
    worktreePath: raw.worktreePath || null,
    worktreeBranch: raw.worktreeBranch || null,
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    tokens: typeof raw.tokens === 'number' ? raw.tokens : null,
  };
}

// Recent jobs, newest first. Cached per file by mtime.
function readJobs(now = Date.now()) {
  let ids;
  try {
    ids = fs.readdirSync(JOBS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const file = path.join(JOBS_DIR, id, 'state.json');
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let hit = cache.get(id);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      let job = null;
      try {
        job = normalizeJob(id, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch { /* partial write: try again next poll */ }
      hit = { mtimeMs: st.mtimeMs, job };
      cache.set(id, hit);
    }
    if (hit.job && now - (hit.job.updatedAt || st.mtimeMs) <= KEEP_MS) out.push(hit.job);
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, MAX_JOBS);
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Args for "commits reachable from HEAD but from no other branch or remote".
// --exclude patterns for --branches must leave off the refs/heads/ prefix.
function onlyHereArgs(worktreePath, branch) {
  return ['-C', worktreePath, 'rev-list', '--count', 'HEAD', '--not',
    ...(branch ? [`--exclude=${branch}`] : []), '--branches', '--remotes'];
}

async function worktreeStatus(job) {
  if (!job.worktreePath || !fs.existsSync(path.join(job.worktreePath, '.git'))) return { exists: false };
  const [status, count] = await Promise.all([
    git(['-C', job.worktreePath, 'status', '--porcelain=v2', '--branch']),
    git(onlyHereArgs(job.worktreePath, job.worktreeBranch)),
  ]);
  if (status == null) return { exists: true, error: true };
  const s = parsePorcelainV2(status);
  const n = Number.parseInt(count, 10);
  return { exists: true, changes: s.dirty + s.untracked, onlyHere: Number.isFinite(n) ? n : 0 };
}

// What the unpushed strip should say about a job's worktree, or null.
function jobAttention(job, wt) {
  if (!wt || !wt.exists || wt.error) return null;
  if (!wt.changes && !wt.onlyHere) return null;
  return {
    jobId: job.jobId,
    sessionId: job.sessionId,
    name: job.name || job.jobId,
    worktree: path.basename(job.worktreePath),
    branch: job.worktreeBranch,
    changes: wt.changes,
    onlyHere: wt.onlyHere,
  };
}

module.exports = { readJobs, normalizeJob, worktreeStatus, jobAttention, onlyHereArgs };
