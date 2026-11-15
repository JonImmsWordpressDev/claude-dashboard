'use strict';
// `claude-dashboard mcp`: a Model Context Protocol server over stdio, so a
// Claude Code session can ask Mission Control what the other sessions are
// doing, search past ones, and check limits. Read-only by construction: the
// four tools below are the whole surface, and each one is a fixed GET to the
// running dashboard on 127.0.0.1 — no listener, nothing that runs a command.
// The pure handler takes `get` so tests drive it without a server.
const http = require('http');
const readline = require('readline');
const { version: VERSION } = require('../package.json');
const { parseSearchQuery } = require('./search');

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const MCP_TOOLS = [
  {
    name: 'live_sessions',
    description:
      'Claude Code sessions running on this machine right now, sessions waiting on the user first: project, title, status, ' +
      'what a waiting session needs, model, estimated cost so far and burn rate, context use, and its latest action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Live sessions', ...READ_ONLY },
  },
  {
    name: 'search_sessions',
    description:
      'Search past and present Claude Code sessions on this machine: every prompt the user sent, session titles, the ' +
      "user's session notes and (deep, the default) full transcripts. Filters go in the query: project:<name>, " +
      'since:7d or since:YYYY-MM-DD, m:<model>, b:<branch>, file:<changed file>. A filter-only query such as ' +
      '"file:functions.php" lists the sessions that changed that file. Use read_session on a sessionId to read one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200, description: 'Words to find, plus any filters.' },
        deep: { type: 'boolean', description: 'Also search full transcripts (slower). Default true.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search sessions', ...READ_ONLY },
  },
  {
    name: 'read_session',
    description:
      "One session's recent turns: what the user said, Claude's replies, and the tools it called with a short summary " +
      'of each input. Long messages are clipped.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'A session id from live_sessions or search_sessions.' },
        last: { type: 'integer', minimum: 1, maximum: 200, description: 'How many of the latest turns to return. Default 40.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: { title: 'Read session', ...READ_ONLY },
  },
  {
    name: 'usage_summary',
    description:
      "The user's Claude usage: 5-hour and weekly limit use with reset times, when the current pace runs out, this " +
      "week's sessions, prompts and estimated cost by project, all-time totals, and the most expensive sessions. Costs are " +
      'estimates at list price.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Usage summary', ...READ_ONLY },
  },
];

const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : null);
const isoAny = (t) => (typeof t === 'string' ? iso(Date.parse(t)) : iso(t));

function liveSummary(state) {
  const sessions = (state.liveSessions || []).map((s) => ({
    sessionId: s.sessionId,
    project: s.projectName,
    title: s.title || null,
    status: s.status,
    needsYou: s.status === 'waiting',
    waitingFor: s.waitingFor || null,
    waitingReason: s.waitingReason || null,
    model: s.model || null,
    estCost: s.estCost ?? null,
    burnRatePerHour: s.burnRate ?? null,
    contextPct: s.context ? s.context.pct : null,
    lastAction: s.lastAction ? [s.lastAction.verb, s.lastAction.target].filter(Boolean).join(' ') : null,
    background: Boolean(s.background),
    startedAt: iso(s.startedAt),
  }));
  sessions.sort((a, b) => Number(b.needsYou) - Number(a.needsYou));
  return { sessions };
}

function searchSummary(r) {
  const out = {
    prompts: (r.prompts || []).map((p) => ({ project: p.projectName, sessionId: p.sessionId, at: iso(p.timestamp), text: p.snippet })),
    titles: (r.titles || []).map((t) => ({ project: t.projectName, sessionId: t.sessionId, at: iso(t.lastActivityAt), title: t.title })),
    notes: (r.notes || []).map((n) => ({ project: n.projectName, sessionId: n.sessionId, at: iso(n.lastActivityAt), note: n.snippet })),
  };
  if (r.transcripts) {
    out.transcripts = {
      matches: r.transcripts.matches.map((m) => ({ project: m.projectName, sessionId: m.sessionId, role: m.role, at: iso(m.ts), text: m.text })),
      scanned: r.transcripts.scanned,
      total: r.transcripts.total,
      complete: r.transcripts.complete,
    };
  }
  return out;
}

function sessionSummary(r, last) {
  const all = r.events || [];
  const events = all.slice(-last).map((e) =>
    e.kind === 'tool'
      ? { kind: 'tool', at: iso(e.ts), tool: e.name, input: e.input }
      : { kind: e.kind, at: iso(e.ts), text: e.text, ...(e.truncated ? { clipped: true } : {}) }
  );
  return {
    sessionId: r.sessionId,
    title: r.title || null,
    project: r.projectName || null,
    note: r.note || null,
    filesChanged: r.changeCount || 0,
    earlierTurnsOmitted: Math.max(0, all.length - events.length) + (r.truncatedTurns || 0),
    events,
  };
}

function usageSummary(state, stats) {
  const q = state.quota || {};
  const f = state.forecast || {};
  return {
    limits: {
      fiveHourPct: q.utilization ?? null,
      fiveHourResetsAt: isoAny(q.resetsAt),
      fiveHourRunsOutAt: iso(f.session && f.session.hitAt),
      weeklyPct: q.weeklyUtilization ?? null,
      weeklyResetsAt: isoAny(q.weeklyResetsAt),
      weekRunsOutAt: iso(f.week && f.week.hitAt),
      stale: Boolean(q.stale),
    },
    week: stats.week || null,
    allTime: stats.totals || null,
    topSessions: (stats.topSessions || []).slice(0, 5).map((s) => ({
      sessionId: s.sessionId, title: s.title, project: s.projectName, model: s.model, cost: s.cost, at: iso(s.lastActivityAt),
    })),
  };
}

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const toolError = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

async function runTool(name, args, get) {
  if (name === 'live_sessions') return text(liveSummary(await get('/api/state')));
  if (name === 'search_sessions') {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (q.length < 2 || q.length > 200) return toolError('query must be 2 to 200 characters.');
    const deep = args.deep === false ? '0' : '1';
    // Echo what the query meant: every result passed these filters, which a
    // filter-only query's matches can't show on their own.
    const p = parseSearchQuery(q);
    const filters = {};
    for (const k of ['project', 'model', 'branch', 'file']) if (p[k]) filters[k] = p[k];
    if (p.since) filters.since = iso(p.since);
    const found = searchSummary(await get(`/api/search?q=${encodeURIComponent(q)}&deep=${deep}`));
    return text({ matchedText: p.text || null, filters, ...found });
  }
  if (name === 'read_session') {
    const id = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    if (!SESSION_ID.test(id)) return toolError('sessionId must be a session id (a UUID) from live_sessions or search_sessions.');
    const last = Number.isInteger(args.last) ? Math.min(200, Math.max(1, args.last)) : 40;
    return text(sessionSummary(await get(`/api/session?id=${id}`), last));
  }
  if (name === 'usage_summary') {
    const [state, stats] = await Promise.all([get('/api/state'), get('/api/stats')]);
    return text(usageSummary(state, stats));
  }
  return null;
}

// One JSON-RPC message in, one reply out (null for notifications).
function createMcpHandler({ get, port = 4517 }) {
  return async function handle(msg) {
    const isRequest = msg && msg.id !== undefined && msg.id !== null;
    if (!isRequest) return null;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const params = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'mission-control', title: 'Claude Mission Control', version: VERSION },
          instructions:
            'Read-only view of the Claude Code sessions on this machine, from the Mission Control dashboard. ' +
            'Use search_sessions to find past work and decisions, read_session to read one, live_sessions for what is ' +
            'running now, usage_summary for limits and cost.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: MCP_TOOLS });
      case 'tools/call': {
        if (!MCP_TOOLS.some((t) => t.name === params.name)) return fail(-32602, `Unknown tool: ${String(params.name).slice(0, 60)}`);
        try {
          return reply(await runTool(params.name, params.arguments || {}, get));
        } catch (e) {
          if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) {
            return reply(toolError(
              `Mission Control isn't running at http://127.0.0.1:${port}. Start it with \`claude-dashboard\` ` +
              '(or `brew services start claude-dashboard`), then try again.'
            ));
          }
          return reply(toolError(`Mission Control error: ${String(e && e.message).slice(0, 200)}`));
        }
      }
      default:
        return fail(-32601, `Method not found: ${String(msg.method).slice(0, 60)}`);
    }
  };
}

// GET a dashboard endpoint on loopback. The path is always one built above.
function dashGet(port, timeoutMs = 15000) {
  return (p) =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 404) return reject(new Error('not found (unknown session?)'));
          if (res.statusCode !== 200) return reject(new Error(`dashboard answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('dashboard sent something that is not JSON'));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('dashboard took too long to answer')));
      req.on('error', reject);
    });
}

// stdio transport: newline-delimited JSON-RPC. stdout carries only protocol
// messages; anything else goes to stderr.
function runMcp() {
  const port = Number(process.env.CLAUDE_DASH_PORT) || 4517;
  const handle = createMcpHandler({ get: dashGet(port), port });
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Replies are async; on stdin close, finish the ones in flight, then exit.
  let pending = 0;
  let closed = false;
  const maybeExit = () => closed && pending === 0 && process.exit(0);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    pending++;
    handle(msg)
      .then((r) => r && send(r), (e) => process.stderr.write(`mcp: ${e && e.stack}\n`))
      .finally(() => {
        pending--;
        maybeExit();
      });
  });
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}

module.exports = { createMcpHandler, MCP_TOOLS, runMcp, liveSummary, searchSummary, sessionSummary, usageSummary };
