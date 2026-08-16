'use strict';
// Launch a session in the configured terminal or the Claude desktop app.
// Paths come from OUR collected state, never from the client.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readConfig, detectTerminals, detectClaudeApp } = require('./config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      resolve(err ? { ok: false, error: String(err.message).slice(0, 200) } : { ok: true });
    });
  });
}

function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Launch `shellCmd` in a new window of the configured terminal, cwd set.
function launchInTerminal(cwd, shellCmd) {
  const configured = readConfig().terminal;
  const installed = detectTerminals();
  const terminal = installed.some((t) => t.id === configured)
    ? configured
    : (installed[0] || { id: process.platform === 'win32' ? 'cmd' : 'terminal' }).id;

  if (process.platform === 'win32') {
    // Untested on real Windows — via `start` so the window detaches.
    if (terminal === 'wt') {
      return run('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'cmd', '/k', shellCmd]);
    }
    if (terminal === 'powershell') {
      return run('cmd', ['/c', 'start', '', 'powershell', '-NoExit', '-Command',
        `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${shellCmd}`]);
    }
    return run('cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && ${shellCmd}`]);
  }

  if (process.platform === 'linux') {
    const keepAlive = `cd ${sq(cwd)} && ${shellCmd}; exec bash -i`;
    if (terminal === 'gnome-terminal') {
      return run('gnome-terminal', [`--working-directory=${cwd}`, '--', 'bash', '-c', keepAlive]);
    }
    if (terminal === 'konsole') {
      return run('konsole', ['--workdir', cwd, '-e', 'bash', '-c', keepAlive]);
    }
    if (terminal === 'kitty' || terminal === 'alacritty') {
      return run(terminal, ['--working-directory', cwd, '-e', 'bash', '-c', keepAlive]);
    }
    return run('xterm', ['-e', 'bash', '-c', keepAlive]);
  }

  if (terminal === 'ghostty') {
    return run('open', [
      '-na', 'Ghostty.app', '--args',
      `--working-directory=${cwd}`,
      '-e', 'zsh', '-ilc', shellCmd,
    ]);
  }

  // iTerm2 / Terminal.app: a temp .command file avoids AppleScript permission
  // prompts. `exec zsh -i` keeps the window alive after the command exits.
  const script = `#!/bin/zsh\ncd ${sq(cwd)}\n${shellCmd}\nexec zsh -i\n`;
  const file = path.join(os.tmpdir(), `claude-dash-${Date.now()}-${Math.floor(Math.random() * 1e6)}.command`);
  try {
    fs.writeFileSync(file, script, { mode: 0o755 });
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e.message).slice(0, 200) });
  }
  const app = terminal === 'iterm' ? 'iTerm' : 'Terminal';
  return run('open', ['-a', app, file]);
}

function openSession({ sessionId, cwd, target }) {
  if (!UUID_RE.test(sessionId)) {
    return Promise.resolve({ ok: false, error: 'invalid session id' });
  }
  if (target === 'app') {
    if (!detectClaudeApp()) {
      return Promise.resolve({ ok: false, error: 'Claude desktop app is not installed' });
    }
    // Claude desktop deep link: imports the CLI session transcript.
    const url = `claude://resume?session=${sessionId}`;
    if (process.platform === 'win32') return run('cmd', ['/c', 'start', '', url]);
    if (process.platform === 'linux') return run('xdg-open', [url]);
    return run('open', [url]);
  }
  if (target === 'terminal') {
    if (!cwd) return Promise.resolve({ ok: false, error: 'unknown project path for session' });
    return launchInTerminal(cwd, `claude --resume ${sessionId}`);
  }
  return Promise.resolve({ ok: false, error: 'unknown target' });
}

function openNewSession(cwd) {
  return launchInTerminal(cwd, 'claude');
}

module.exports = { openSession, openNewSession };
