#!/usr/bin/env node
'use strict';
// Claude Projects Dashboard — local-only server.
// Zero dependencies; Node >= 18.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Collector } = require('./lib/collector');
const { openSession, openNewSession } = require('./lib/opener');
const { projectDetail } = require('./lib/detail');
const { sessionTranscript } = require('./lib/transcript-view');
const { searchHistory, searchTitles, searchTranscripts } = require('./lib/search');
const { sessionTitle } = require('./lib/transcripts');
const { friendlyName } = require('./lib/names');
const cfg = require('./lib/config');
const { isProjectMuted } = require('./lib/notify');
const { recentCommits, linkCommitsToSessions } = require('./lib/gitlog');
const { demoState, demoStats, demoSession } = require('./lib/demo');
const DEMO = process.env.CLAUDE_DASH_DEMO === '1';

const PORT = Number(process.env.CLAUDE_DASH_PORT) || 4517;
// Default loopback-only. For remote access prefer `tailscale serve` (keeps
// this binding); CLAUDE_DASH_HOST is the explicit opt-out.
const HOST = process.env.CLAUDE_DASH_HOST || '127.0.0.1';
const DEV = process.env.CLAUDE_DASH_DEV === '1';
const INDEX = path.join(__dirname, 'public', 'index.html');

const VERSION = require('./package.json').version;
const collector = new Collector();
const sseClients = new Set();

let indexCache = null;
function indexHtml() {
  if (DEV || !indexCache) indexCache = fs.readFileSync(INDEX);
  return indexCache;
}

function allowedHost(req) {
  if (HOST !== '127.0.0.1') return true; // explicitly opted into remote access
  const h = String(req.headers.host || '');
  return h.startsWith('127.0.0.1') || h.startsWith('localhost');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || HOST !== '127.0.0.1';
}

function readBody(req, res, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 16384) req.destroy();
  });
  req.on('end', () => {
    try {
      cb(JSON.parse(body || '{}'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"bad json"}');
    }
  });
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const server = http.createServer((req, res) => {
  if (!allowedHost(req)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: 'self'; connect-src 'self'",
    });
    res.end(indexHtml());
    return;
  }

  // PWA assets, exact names only.
  if (url === '/manifest.webmanifest' || url === '/icon.svg') {
    const type = url === '/icon.svg' ? 'image/svg+xml' : 'application/manifest+json';
    fs.readFile(path.join(__dirname, 'public', url.slice(1)), (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    });
    return;
  }

  // Demo mode: canned data for every API route, static assets as normal.
  if (DEMO && url.startsWith('/api/')) {
    if (url === '/api/state') return json(res, 200, demoState());
    if (url === '/api/health') return json(res, 200, { ok: true, demo: true, version: VERSION });
    if (url === '/api/stats') return json(res, 200, demoStats());
    if (url === '/api/session') return json(res, 200, demoSession());
    if (url === '/api/search') return json(res, 200, { q: '', prompts: [], titles: [], transcripts: null });
    if (url === '/api/project') {
      return json(res, 200, {
        path: '/demo/acme-storefront', sessions: [], commits: [], muted: false,
        claudeMd: [], memory: [], skills: [], agents: [], commands: [], settings: {},
      });
    }
    if (url === '/api/config' && req.method === 'GET') {
      return json(res, 200, { demo: true, notifications: true, usageApi: false, weeklyBudget: 200, terminals: [], resolvedTerminal: { id: 'terminal', label: 'Terminal' }, claudeApp: false, names: {}, ignores: [], version: VERSION, errors: [] });
    }
    if (url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = () => res.write(`data: ${JSON.stringify(demoState())}\n\n`);
      send();
      const t = setInterval(send, 5000);
      req.on('close', () => clearInterval(t));
      return;
    }
    return json(res, 200, { ok: false, error: 'not available in demo mode' });
  }

  // Bundled font files only — no traversal, extension whitelisted.
  if (url.startsWith('/fonts/')) {
    const name = path.basename(url);
    if (!/^[\w-]+\.woff2$/.test(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    fs.readFile(path.join(__dirname, 'public', 'fonts', name), (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    });
    return;
  }

  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(collector.state));
    return;
  }

  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, uptime: process.uptime(), version: VERSION }));
    return;
  }

  // Manual only — the dashboard never phones home on its own. This runs
  // when the user clicks "check for updates" in settings.
  if (url === '/api/update-check') {
    fetch('https://api.github.com/repos/JonImmsWordpressDev/claude-dashboard/releases/latest', {
      headers: { 'User-Agent': 'claude-dashboard', Accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub responded ${r.status}`))))
      .then((rel) => {
        const latest = String(rel.tag_name || '').replace(/^v/, '');
        json(res, 200, {
          current: VERSION,
          latest,
          upToDate: !latest || latest === VERSION,
          url: rel.html_url || 'https://github.com/JonImmsWordpressDev/claude-dashboard/releases',
        });
      })
      .catch((e) => json(res, 502, { error: String(e.message).slice(0, 120) }));
    return;
  }

  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(collector.state)}\n\n`);
    sseClients.add(res);
    collector.setClientCount(sseClients.size);
    req.on('close', () => {
      sseClients.delete(res);
      collector.setClientCount(sseClients.size);
    });
    return;
  }

  if (url === '/api/project') {
    // Path must be one of the known project roots — never an arbitrary path.
    const requested = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    const known = collector
      .projectPaths()
      .find((p) => p.toLowerCase() === requested.toLowerCase());
    if (!known) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"unknown project"}');
      return;
    }
    Promise.all([projectDetail(known), recentCommits(known)])
      .then(([detail, commits]) => {
        detail.sessions = collector.allSessions(known);
        detail.commits = linkCommitsToSessions(commits, detail.sessions);
        detail.muted = isProjectMuted(known, cfg.readConfig().mutedProjects);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(detail));
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
      });
    return;
  }

  if (url === '/api/stats') {
    json(res, 200, collector.statsSummary());
    return;
  }

  if (url === '/api/config' && req.method === 'GET') {
    json(res, 200, {
      ...cfg.readConfig(),
      version: VERSION,
      errors: collector.state.errors || [],
      terminals: cfg.detectTerminals(),
      resolvedTerminal: cfg.resolvedTerminal(),
      claudeApp: cfg.detectClaudeApp(),
      names: cfg.readNames(),
      ignores: cfg.readIgnores(),
    });
    return;
  }

  if (req.method === 'POST' && ['/api/config', '/api/names', '/api/ignore'].includes(url)) {
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    readBody(req, res, (payload) => {
      try {
        if (url === '/api/config') {
          if (payload.pinSession !== undefined) {
            const id = String(payload.pinSession || '');
            if (!collector.findSessionFile(id)) return json(res, 404, { ok: false, error: 'unknown session' });
            const pinned = cfg.togglePin(id);
            collector.assemble();
            return json(res, 200, { ok: true, pinned });
          }
          if (payload.mutePath !== undefined) {
            const known = collector
              .projectPaths()
              .find((p) => p.toLowerCase() === String(payload.mutePath || '').toLowerCase());
            if (!known) return json(res, 404, { ok: false, error: 'unknown project' });
            cfg.setProjectMuted(known, payload.muted !== false);
          } else {
            cfg.updateConfig(payload);
          }
        } else if (url === '/api/names') {
          const known = collector
            .projectPaths()
            .find((p) => p.toLowerCase() === String(payload.path || '').toLowerCase());
          if (!known) return json(res, 404, { ok: false, error: 'unknown project' });
          cfg.setName(known, String(payload.name || ''));
        } else if (payload.remove) {
          cfg.removeIgnore(String(payload.path || ''));
        } else {
          const known = collector
            .projectPaths()
            .find((p) => p.toLowerCase() === String(payload.path || '').toLowerCase());
          if (!known) return json(res, 404, { ok: false, error: 'unknown project' });
          cfg.addIgnore(known);
        }
        collector.assemble(); // reflect the change on the next state push
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 500, { ok: false, error: String(e.message).slice(0, 200) });
      }
    });
    return;
  }

  if (url === '/api/session') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const id = params.get('id') || '';
    const after = Math.max(0, Number(params.get('after')) || 0);
    const found = collector.findSessionFile(id);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"unknown session"}');
      return;
    }
    sessionTranscript(found.file, after)
      .then((t) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sessionId: id, title: found.title, projectName: found.projectName, ...t }));
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
      });
    return;
  }

  if (url === '/api/search') {
    const q = (new URL(req.url, 'http://localhost').searchParams.get('q') || '').trim();
    if (q.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"query too short"}');
      return;
    }
    const deep = new URL(req.url, 'http://localhost').searchParams.get('deep') === '1';
    Promise.all([
      searchHistory(q),
      deep ? searchTranscripts(q, collector.raw.transcriptGroups) : Promise.resolve(null),
    ])
      .then(([prompts, transcripts]) => {
        const titles = searchTitles(q, collector.raw.transcriptGroups, sessionTitle);
        for (const r of prompts) r.projectName = friendlyName(r.project);
        for (const r of titles) r.projectName = friendlyName(r.project);
        if (transcripts) for (const r of transcripts.matches) r.projectName = friendlyName(r.project);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ q, prompts, titles, transcripts }));
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
      });
    return;
  }

  if (url === '/api/open' && req.method === 'POST') {
    // Same-origin only: browsers always send Origin on cross-origin POSTs.
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"forbidden"}');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"bad json"}');
        return;
      }
      // Fresh session in a known project dir (terminal only).
      if (payload.newSession) {
        const known = collector
          .projectPaths()
          .find((p) => p.toLowerCase() === String(payload.projectPath || '').toLowerCase());
        if (!known) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"unknown project"}');
          return;
        }
        const result = await openNewSession(known);
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      const found = collector.findSession(String(payload.sessionId || ''));
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"unknown session"}');
        return;
      }
      if (found.live && payload.target === 'terminal') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"session is already running"}');
        return;
      }
      const result = await openSession({
        sessionId: String(payload.sessionId),
        cwd: found.cwd,
        target: String(payload.target || ''),
      });
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

collector.onChange((state) => {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) res.write(payload);
});

const pingTimer = setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25_000);
pingTimer.unref();

(DEMO ? Promise.resolve() : collector.start()).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`claude-dashboard listening on http://${HOST}:${PORT}${DEMO ? ' (demo mode)' : ''}`);
  });
});

server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
