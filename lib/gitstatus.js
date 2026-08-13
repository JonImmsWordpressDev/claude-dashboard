'use strict';
// Git status per project via `git -C <path> status --porcelain=v2 --branch`.
// execFile arg-arrays only (paths contain spaces). Keeps last good values.
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const lastGood = new Map(); // projectPath -> git object

async function isGitRepo(projectPath) {
  try {
    // .git is a dir in normal repos, a FILE in worktrees.
    await fs.stat(path.join(projectPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

function runGitStatus(projectPath) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', projectPath, 'status', '--porcelain=v2', '--branch'],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const prev = lastGood.get(projectPath);
          resolve(prev ? { ...prev, error: shortErr(err) } : { isRepo: true, error: shortErr(err) });
          return;
        }
        const git = parsePorcelainV2(stdout);
        lastGood.set(projectPath, git);
        resolve(git);
      }
    );
  });
}

function parsePorcelainV2(text) {
  const git = { isRepo: true, branch: null, dirty: 0, untracked: 0, ahead: null, behind: null, error: null };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length).trim();
      git.branch = h === '(detached)' ? '(detached)' : h;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        git.ahead = Number(m[1]);
        git.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      git.dirty++;
    } else if (line.startsWith('? ')) {
      git.untracked++;
    }
  }
  return git;
}

function shortErr(err) {
  const msg = String(err.message || err).split('\n')[0];
  return msg.slice(0, 120);
}

// Pooled: at most 3 concurrent git processes.
async function collectGitStatus(projectPaths) {
  const results = new Map();
  const queue = [...projectPaths];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      if (!(await isGitRepo(p))) {
        results.set(p, { isRepo: false });
        continue;
      }
      results.set(p, await runGitStatus(p));
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { collectGitStatus, parsePorcelainV2 };
