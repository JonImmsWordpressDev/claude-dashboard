'use strict';
// Self-update: figure out how this copy of the dashboard was installed, and
// run the matching update command. The server never takes a path or command
// from the client — everything derives from the app's own location.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { canonicalize } = require('./paths');

const PKG_NAME = require('../package.json').name;

// Pure: appDir + "does .git exist there" -> 'git' | 'npm' | 'npx' | 'brew' | 'unknown'.
// Location signals (brew Cellar, npx cache, non-npm package managers) win over
// a .git dir: those are package-manager-owned trees we must never git-pull in.
// pnpm/yarn/volta/bun globals also live under node_modules, but running
// `npm install -g` there installs a second copy under npm's own prefix while
// the running copy stays old — so they get manual instructions instead.
function detectInstallKind(appDir, hasGitDir) {
  const p = canonicalize(appDir).toLowerCase();
  if (p.includes('/cellar/') || p.includes('/homebrew/')) return 'brew';
  if (p.includes('/_npx/')) return 'npx';
  if (['/pnpm/', '/yarn/', '/.yarn/', '/volta/', '/.volta/', '/.bun/'].some((sig) => p.includes(sig))) return 'unknown';
  if (hasGitDir) return 'git';
  if (p.includes('/node_modules/')) return 'npm';
  return 'unknown';
}

// Pure: install kind -> either a fixed command to run, or instructions to
// show. The command list is closed — nothing here ever comes from a request.
function updatePlan(kind, pkgName) {
  if (kind === 'git') return { type: 'run', cmd: 'git', args: ['pull', '--ff-only'] };
  if (kind === 'npm') return { type: 'run', cmd: 'npm', args: ['install', '-g', `${pkgName}@latest`] };
  if (kind === 'brew') return { type: 'manual', message: `Run: brew upgrade ${pkgName}` };
  if (kind === 'npx') return { type: 'manual', message: `Quit the dashboard and re-run npx ${pkgName} — npx fetches the newest release each time.` };
  return { type: 'manual', message: 'Update with the tool you installed with, or download from https://github.com/JonImmsWordpressDev/claude-dashboard/releases' };
}

// Pure: where npm's CLI JS lives relative to the node binary's directory —
// the unix prefix layout and the Windows layout. Running it via our own
// process.execPath sidesteps both the service manager's minimal PATH
// (launchd/systemd ship no PATH, so bare 'npm' is ENOENT) and Windows,
// where 'npm' is npm.cmd and can't be spawned without a shell.
function npmCliCandidates(nodeDir) {
  return [
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

// launchd (KeepAlive) and systemd (Restart) relaunch us after an update exit;
// a terminal-run process must not be killed. Signals, most reliable first:
// our own service definitions set CLAUDE_DASH_SERVICE=1; systemd sets
// INVOCATION_ID for every unit, which covers units deployed before that var
// existed; ppid 1 on macOS covers launchd agents installed before it (kept
// mac-only so an orphaned `dashboard &` run on Linux isn't misread).
function serviceManaged() {
  if (process.env.CLAUDE_DASH_SERVICE === '1') return true;
  if (process.env.INVOCATION_ID) return true;
  return process.platform === 'darwin' && process.ppid === 1;
}

function readPkgVersion(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// Pure: did the update leave a different version on disk than the one this
// process is running? The before/after-on-disk comparison is wrong when the
// tree was already updated (a manual git pull, a previous click that didn't
// restart): disk == disk, but the running process is still old and needs
// the restart.
function updateOutcome(runningVersion, diskVersion, managed) {
  const unchanged = !diskVersion || diskVersion === runningVersion;
  return { unchanged, willRestart: !unchanged && managed };
}

function runSelfUpdate(appDir, runningVersion) {
  const kind = detectInstallKind(appDir, fs.existsSync(path.join(appDir, '.git')));
  const plan = updatePlan(kind, PKG_NAME);
  if (plan.type === 'manual') {
    return Promise.resolve({ ok: false, kind, manual: plan.message });
  }
  let cmd = plan.cmd;
  let args = plan.args;
  if (kind === 'npm') {
    const cli = npmCliCandidates(path.dirname(process.execPath)).find((p) => fs.existsSync(p));
    if (cli) {
      cmd = process.execPath;
      args = [cli, ...plan.args];
    }
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: appDir, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, kind, error: String(stderr || err.message).slice(0, 300) });
        return;
      }
      // The command exiting 0 isn't proof anything changed: npm can re-fetch
      // the same version while a release is still publishing, and git can
      // pull nothing. Only a version on disk that differs from the one we're
      // running earns a restart.
      const after = readPkgVersion(appDir);
      const { unchanged, willRestart } = updateOutcome(runningVersion, after, serviceManaged());
      resolve({
        ok: true,
        kind,
        version: after || undefined,
        unchanged,
        willRestart,
        output: String(stdout).slice(0, 300),
      });
    });
  });
}

module.exports = { detectInstallKind, updatePlan, npmCliCandidates, updateOutcome, runSelfUpdate };
