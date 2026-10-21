'use strict';
// Phone view: an opt-in second listener on the home network or Tailscale.
//
// It serves exactly three things: the phone page, the bundled fonts, and a
// small read-only JSON feed (who needs you, limits). No transcripts, no
// paths, no /api/* routes, nothing that runs a command. The feed needs the
// pairing key as a Bearer header; the key travels to the phone in the URL
// fragment (#k=...), which browsers never send to a server.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CLAUDE_DASH_REMOTE_PORT) || 4518;
const FAIL_LIMIT = 20; // bad keys per address per window before we stop answering
const FAIL_WINDOW_MS = 10 * 60 * 1000;

function newKey() {
  return crypto.randomBytes(24).toString('base64url');
}

const isTailscale = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10, Tailscale's CGNAT range
};
const isPrivate = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

// The address to listen on for a mode, from os.networkInterfaces() output.
function pickAddress(ifaces, mode) {
  const v4 = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) v4.push({ name, ip: a.address });
    }
  }
  if (mode === 'tailscale') return (v4.find((a) => isTailscale(a.ip)) || {}).ip || null;
  const lan = v4.filter((a) => isPrivate(a.ip) && !isTailscale(a.ip));
  // Prefer the usual Wi-Fi/Ethernet interfaces over VPN and bridge ones.
  return (lan.find((a) => /^(en|eth|wl)/.test(a.name)) || lan[0] || {}).ip || null;
}

function checkKey(authHeader, key) {
  if (!key || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  const a = Buffer.from(authHeader.slice(7));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The phone feed: only what the phone page shows.
function mobileState(state) {
  const s = state || {};
  const live = (s.liveSessions || []).map((l) => ({
    projectName: l.projectName,
    title: l.title || '',
    status: l.status,
    reason: l.waitingReason ? { kind: l.waitingReason.kind, text: String(l.waitingReason.text || '').slice(0, 200) } : null,
    waitingMin: l.waitingMin ?? null,
    quietMin: l.quietMin ?? null,
    startedAt: l.startedAt || null,
    estCost: l.estCost ?? null,
    contextPct: l.context ? l.context.pct : null,
    background: !!l.background,
  }));
  const q = s.quota;
  const f = s.forecast || {};
  return {
    generatedAt: s.generatedAt || Date.now(),
    waiting: live.filter((l) => l.status === 'waiting').length,
    live,
    limits: q && !q.stale ? {
      session: q.utilization ?? null,
      week: q.weeklyUtilization ?? null,
      sessionHitAt: f.session ? f.session.hitAt : null,
      weekHitAt: f.week ? f.week.hitAt : null,
    } : null,
  };
}

function createRemoteServer({ getState, readConfig, publicDir }) {
  let server = null;
  let current = null; // { host, mode }
  let lastError = null;
  const fails = new Map(); // ip -> { n, since }

  function handle(req, res) {
    const url = req.url.split('?')[0];
    const ip = req.socket.remoteAddress || '';
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (req.method !== 'GET') {
      res.writeHead(405, base);
      return res.end();
    }
    if (url === '/' || url === '/m') {
      fs.readFile(path.join(publicDir, 'mobile.html'), (err, buf) => {
        if (err) { res.writeHead(500, base); return res.end(); }
        res.writeHead(200, {
          ...base,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
        });
        res.end(buf);
      });
      return;
    }
    if (url.startsWith('/fonts/')) {
      const name = path.basename(url);
      if (!/^[\w-]+\.woff2$/.test(name)) { res.writeHead(404, base); return res.end(); }
      fs.readFile(path.join(publicDir, 'fonts', name), (err, buf) => {
        if (err) { res.writeHead(404, base); return res.end(); }
        res.writeHead(200, { ...base, 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' });
        res.end(buf);
      });
      return;
    }
    if (url === '/m/state') {
      const f = fails.get(ip);
      if (f && Date.now() - f.since < FAIL_WINDOW_MS && f.n >= FAIL_LIMIT) {
        res.writeHead(429, base);
        return res.end();
      }
      if (!checkKey(req.headers.authorization, readConfig().remoteKey)) {
        const fresh = !f || Date.now() - f.since >= FAIL_WINDOW_MS;
        fails.set(ip, fresh ? { n: 1, since: Date.now() } : { n: f.n + 1, since: f.since });
        res.writeHead(401, base);
        return res.end();
      }
      fails.delete(ip);
      res.writeHead(200, { ...base, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(mobileState(getState())));
    }
    res.writeHead(404, base);
    res.end();
  }

  function stop() {
    if (server) server.close();
    server = null;
    current = null;
  }

  // Start, move, or stop the listener to match config. Safe to call often.
  function apply(cfg) {
    if (!cfg.remoteEnabled || !cfg.remoteKey) {
      stop();
      lastError = null;
      return;
    }
    const mode = cfg.remoteMode === 'tailscale' ? 'tailscale' : 'lan';
    const host = pickAddress(os.networkInterfaces(), mode);
    if (!host) {
      stop();
      lastError = mode === 'tailscale' ? 'No Tailscale address on this Mac. Is Tailscale running?' : 'No home network address found. Is Wi-Fi connected?';
      return;
    }
    if (current && current.host === host) return;
    stop();
    lastError = null;
    const s = http.createServer(handle);
    s.on('error', (err) => {
      lastError = err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Set CLAUDE_DASH_REMOTE_PORT to pick another.` : err.message;
      if (server === s) { server = null; current = null; }
    });
    s.listen(PORT, host);
    server = s;
    current = { host, mode };
  }

  function status(cfg) {
    const url = current && cfg.remoteKey ? `http://${current.host}:${PORT}/#k=${cfg.remoteKey}` : null;
    return { enabled: !!cfg.remoteEnabled, mode: cfg.remoteMode === 'tailscale' ? 'tailscale' : 'lan', running: !!current, url, error: lastError };
  }

  return { apply, status, stop };
}

module.exports = { createRemoteServer, pickAddress, mobileState, checkKey, newKey, REMOTE_PORT: PORT };
