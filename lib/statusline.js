'use strict';
// `claude-dashboard statusline`: one line for Claude Code's statusLine
// setting. Reads Claude Code's JSON on stdin and, when the dashboard is up,
// adds what only it knows: other sessions waiting on you and the limit
// forecast. Must stay fast, so the dashboard gets a short timeout and is
// optional.
const http = require('http');

const AMBER = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const STATE_TIMEOUT_MS = 400;

function clock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// input: Claude Code's statusline JSON. state: the dashboard's /api/state,
// or null when it isn't running.
function formatStatusline(input, state, { color = true } = {}) {
  const amber = (s) => (color ? AMBER + s + RESET : s);
  const dim = (s) => (color ? DIM + s + RESET : s);
  const parts = [];

  if (state) {
    const waiting = (state.liveSessions || []).filter((s) => s.status === 'waiting' && s.sessionId !== input.session_id);
    if (waiting.length) {
      const first = waiting[0].projectName || 'a session';
      parts.push(amber(`❯ ${waiting.length === 1 ? first : `${waiting.length} sessions`} need${waiting.length === 1 ? 's' : ''} you`));
    }
  }

  if (input.model && input.model.display_name) parts.push(input.model.display_name);

  const ctx = input.context_window && input.context_window.used_percentage;
  if (typeof ctx === 'number') {
    const s = `ctx ${Math.round(ctx)}%`;
    parts.push(ctx >= 70 ? amber(s) : s);
  }

  const limits = input.rate_limits || {};
  const forecast = (state && state.forecast) || {};
  for (const [key, label, f] of [['five_hour', '5h', forecast.session], ['seven_day', 'week', forecast.week]]) {
    const pct = limits[key] && limits[key].used_percentage;
    if (typeof pct !== 'number') continue;
    if (f && f.hitAt && pct < 100) parts.push(amber(`${label} ${Math.round(pct)}% → ${clock(f.hitAt)}`));
    else if (key === 'five_hour' || pct >= 50) parts.push(`${label} ${Math.round(pct)}%`);
  }

  const cost = input.cost && input.cost.total_cost_usd;
  if (typeof cost === 'number' && cost >= 0.01) parts.push(dim(`$${cost.toFixed(2)}`));

  return parts.join(dim(' · '));
}

function fetchState(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: STATE_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function runStatusline() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw); } catch { /* print what we can */ }
  const state = await fetchState(Number(process.env.CLAUDE_DASH_PORT) || 4517);
  process.stdout.write(formatStatusline(input, state) + '\n');
}

module.exports = { formatStatusline, runStatusline };
