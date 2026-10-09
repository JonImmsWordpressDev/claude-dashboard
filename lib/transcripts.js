'use strict';
// Session transcript metadata from ~/.claude/projects/<enc>/<sessionId>.jsonl.
// Files reach 14MB; never full-parse. Read head (cwd/branch/first prompt),
// tail (last-prompt / away_summary), and one streaming substring pass for the
// last ai-title. Cached by (mtime, size).
const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR, worktreeRoot } = require('./paths');
const { estimateCost, costReport, totalTokens, cacheHitRatio, contextWindow } = require('./pricing');
const { recordChange, mergeChanges, realPathOf } = require('./changes');
const { parseAgentMeta } = require('./teams');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 16 * 1024;
// How many recent tool_use ids to remember for attributing failed results.
const TOOL_RING = 256;

function countToolUses(scan, content) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || !b.id) continue;
    const ring = scan.toolIds || (scan.toolIds = []);
    if (ring.some((e) => e.id === b.id)) continue; // replayed record
    const name = typeof b.name === 'string' && b.name ? b.name : '(unnamed)';
    const tools = scan.tools || (scan.tools = {});
    const t = tools[name] || (tools[name] = { count: 0, errors: 0 });
    t.count++;
    ring.push({ id: b.id, name });
    if (ring.length > TOOL_RING) ring.shift();
  }
}

function countToolErrors(scan, content) {
  if (!Array.isArray(content)) return;
  for (const p of content) {
    if (!p || p.type !== 'tool_result' || p.is_error !== true) continue;
    const hit = (scan.toolIds || []).find((e) => e.id === p.tool_use_id);
    const name = hit ? hit.name : '(unknown)';
    const tools = scan.tools || (scan.tools = {});
    const t = tools[name] || (tools[name] = { count: 0, errors: 0 });
    t.errors++;
  }
}

// absPath -> { mtimeMs, size, meta }
const cache = new Map();

async function scanAllTranscripts() {
  let dirs;
  try {
    dirs = await fsp.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const sessions = [];
  for (const dir of dirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let files;
    try {
      files = await fsp.readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const abs = path.join(dirPath, f);
      const sessionId = f.replace(/\.jsonl$/, '');
      try {
        const meta = await scanFile(abs, sessionId);
        if (meta) {
          const sub = await scanSubagents(path.join(dirPath, sessionId, 'subagents'));
          meta.subagentUsage = sub && sub.usage;
          meta.subagentDays = sub && sub.days;
          meta.subagentCount = sub ? sub.count : 0;
          meta.agents = sub && sub.agents.length ? sub.agents : null;
          if (sub && sub.changes && Object.keys(sub.changes).length) {
            meta.changes = mergeChanges(mergeChanges({}, meta.changes), sub.changes);
          }
          meta.changeCount = meta.changes ? Object.keys(meta.changes).length : 0;
          sessions.push(meta);
        }
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  return sessions;
}

async function scanFile(abs, sessionIdFromName) {
  const st = await fsp.stat(abs);
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.meta;
  // Incremental scan state survives across rescans of a growing file.
  const scan = hit && hit.scan && st.size >= hit.scan.offset
    ? hit.scan
    : { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null, lastModel: null, changes: undefined };

  const fh = await fsp.open(abs, 'r');
  let head, tail;
  try {
    const headLen = Math.min(HEAD_BYTES, st.size);
    const headBuf = Buffer.alloc(headLen);
    await fh.read(headBuf, 0, headLen, 0);
    head = headBuf.toString('utf8');

    const tailLen = Math.min(TAIL_BYTES, st.size);
    const tailBuf = Buffer.alloc(tailLen);
    await fh.read(tailBuf, 0, tailLen, st.size - tailLen);
    tail = tailBuf.toString('utf8');
  } finally {
    await fh.close();
  }

  const meta = {
    sessionId: sessionIdFromName,
    file: abs,
    cwd: null,
    gitBranch: null,
    startedAt: null,
    lastActivityAt: st.mtimeMs,
    firstUserPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    awaySummaryAt: null,
    aiTitle: null,
    waitingReason: null,
  };

  // Head: first ~40 lines; the first line can be queue-operation without cwd.
  const headLines = head.split('\n').slice(0, 40);
  for (const line of headLines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // possibly truncated final head line
    }
    if (meta.cwd === null && typeof rec.cwd === 'string') {
      meta.cwd = rec.cwd;
      meta.gitBranch = rec.gitBranch || null;
    }
    if (meta.startedAt === null && rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (!Number.isNaN(t)) meta.startedAt = t;
    }
    if (meta.firstUserPrompt === null) {
      const text = extractUserText(rec);
      if (text) meta.firstUserPrompt = text.slice(0, 120);
    }
    if (meta.cwd && meta.startedAt && meta.firstUserPrompt) break;
  }

  // Tail: last complete lines carry last-prompt / away_summary, and the
  // final turn tells us what a waiting session is waiting for.
  const tailLines = tail.split('\n').filter((l) => l.trim());
  const tailRecords = [];
  for (let i = tailLines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(tailLines[i]);
    } catch {
      continue; // first tail line is usually a partial record
    }
    tailRecords.push(rec);
    if (meta.lastPrompt === null && rec.type === 'last-prompt' && rec.lastPrompt) {
      meta.lastPrompt = String(rec.lastPrompt).slice(0, 200);
    }
    if (meta.awaySummary === null && rec.type === 'system' && rec.subtype === 'away_summary' && rec.content) {
      meta.awaySummary = String(rec.content).slice(0, 800);
      const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      meta.awaySummaryAt = Number.isNaN(t) ? null : t;
    }
  }
  tailRecords.reverse(); // file order, oldest first
  meta.waitingReason = waitingReason(tailRecords);

  await incrementalScan(abs, st.size, scan);
  meta.aiTitle = scan.aiTitle;
  meta.usage = scan.usage;
  meta.days = scan.days;
  meta.waits = scan.waits || null;
  meta.model = scan.lastModel || null;
  meta.changes = scan.changes || null;
  meta.context = scan.lastContext || null;
  meta.tools = scan.tools || null;

  cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, meta, scan });
  return meta;
}

// Reads only the bytes appended since the last scan, up to the last complete
// line. Accumulates the latest ai-title and per-model token usage. Usage is
// deduped by message id — one API response spans several assistant records
// that all carry the same usage object.
async function incrementalScan(abs, size, scan) {
  if (size <= scan.offset) return;
  const fh = await fsp.open(abs, 'r');
  try {
    const len = size - scan.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, scan.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return; // no complete new line yet
    scan.offset += lastNl + 1;
    for (const line of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
      scanLine(line, scan);
    }
  } finally {
    await fh.close();
  }
}

function scanLine(line, scan) {
  if (line.includes('"type":"ai-title"')) {
    try {
      const rec = JSON.parse(line);
      if (rec.aiTitle) scan.aiTitle = rec.aiTitle;
    } catch {
      /* ignore */
    }
  } else if (line.includes('"type":"assistant"') && line.includes('"usage"')) {
    try {
      const rec = JSON.parse(line);
      const m = rec.message;
      if (!m || !m.usage) return;
      if ((m.model || '').startsWith('<')) return; // '<synthetic>' harness records
      countToolUses(scan, m.content); // every record: blocks of one message are split across records
      if (m.id && m.id === scan.lastMsgId) return;
      scan.lastMsgId = m.id || null;
      const model = m.model || 'unknown';
      scan.lastModel = model; // most recent real model = the session's model
      addUsage(scan.usage, model, m.usage);
      scan.lastContext = {
        tokens: (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0),
        model,
        at: rec.timestamp ? Date.parse(rec.timestamp) || null : null,
      };
      const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (!Number.isNaN(t)) {
        scan.lastAssistantTs = t;
        const days = scan.days || (scan.days = {});
        const day = days[dayKey(t)] || (days[dayKey(t)] = {});
        addUsage(day, model, m.usage);
      }
    } catch {
      /* ignore */
    }
  } else if (line.includes('"type":"file-history-delta"')) {
    try {
      const rec = JSON.parse(line);
      const p = realPathOf(rec.trackingPath, rec.backup);
      if (p) recordChange(scan.changes || (scan.changes = {}), p, rec.backup);
    } catch {
      /* ignore */
    }
  } else if (line.includes('"type":"file-history-snapshot"')) {
    try {
      const rec = JSON.parse(line);
      const tracked = rec.snapshot && rec.snapshot.trackedFileBackups;
      for (const [key, backup] of Object.entries(tracked || {})) {
        const p = realPathOf(key, backup);
        if (p) recordChange(scan.changes || (scan.changes = {}), p, backup);
      }
    } catch {
      /* ignore */
    }
  } else if (line.includes('"is_error":true') && line.includes('"tool_use_id"')) {
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'user' && rec.message) countToolErrors(scan, rec.message.content);
    } catch {
      /* ignore */
    }
  } else if (scan.lastAssistantTs && line.includes('"type":"user"') && !line.includes('"tool_use_id"')) {
    // Your next real prompt after assistant output: bucket the gap.
    // <5s is automation, >30min you were away — neither says anything
    // about response time, but both consume the pending assistant mark.
    try {
      const rec = JSON.parse(line);
      if (!extractUserText(rec)) return;
      const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (Number.isNaN(t)) return;
      const gap = t - scan.lastAssistantTs;
      scan.lastAssistantTs = null;
      if (gap < 5000 || gap > 30 * 60000) return;
      const waits = scan.waits || (scan.waits = [0, 0, 0, 0]);
      waits[gap < 30000 ? 0 : gap < 120000 ? 1 : gap < 600000 ? 2 : 3]++;
    } catch {
      /* ignore */
    }
  }
}

function addUsage(byModel, model, usage) {
  const u = byModel[model] || (byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  u.input += usage.input_tokens || 0;
  u.output += usage.output_tokens || 0;
  u.cacheRead += usage.cache_read_input_tokens || 0;
  u.cacheCreation += usage.cache_creation_input_tokens || 0;
}

// Local-time day bucket key, e.g. '2026-08-10'.
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function extractUserText(rec) {
  if (rec.type !== 'user' || !rec.message) return null;
  const c = rec.message.content;
  if (typeof c === 'string') return cleanPrompt(c);
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part && part.type === 'text' && part.text) return cleanPrompt(part.text);
    }
  }
  return null;
}

const NOISE_PREFIXES = [
  '[SYSTEM NOTIFICATION',
  'Base directory for this skill',
  'Caveat: The messages below',
  'This session is being continued from',
];

function cleanPrompt(s) {
  const t = s.trim();
  // Anything tag-shaped is harness plumbing (<system-reminder>, <command-*>,
  // <local-command-caveat>, <task-notification>, ...), not a human prompt.
  if (!t || t.startsWith('<') || NOISE_PREFIXES.some((p) => t.startsWith(p))) return null;
  return t.replace(/\s+/g, ' ');
}

// ---------- what a waiting session is waiting for ----------
// Derived from the parsed tail records (oldest first). "Last turn" = every
// record after the last real user prompt (tool_results and harness noise
// don't start a turn). Pure so it's unit-testable.
const REASON_TEXT_CAP = 200;
const PERMISSION_CAP = 120;
const OPTION_CAP = 40;
const MAX_OPTIONS = 6;

function clip(s, n) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, n);
}

function toolResultIds(rec) {
  const out = [];
  const c = rec.message && rec.message.content;
  if (!Array.isArray(c)) return out;
  for (const p of c) if (p && p.type === 'tool_result' && p.tool_use_id) out.push(p.tool_use_id);
  return out;
}

function isRealPrompt(rec) {
  return rec.type === 'user' && !!rec.message && toolResultIds(rec).length === 0 && !!extractUserText(rec);
}

// The most readable single argument of a tool call, for permission prompts.
function toolArg(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'skill', 'prompt', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

// Strip list markers, headings, quotes, and inline emphasis from one line.
function plainLine(line) {
  return line
    .replace(/^[\s#>*\-•]+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/[*`]/g, '')
    .trim();
}

function replyLine(text) {
  const lines = String(text).split('\n').map(plainLine).filter(Boolean);
  if (!lines.length) return null;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].endsWith('?')) return lines[i];
  const paragraphs = String(text).split(/\n\s*\n/).map((p) => p.split('\n').map(plainLine).filter(Boolean)).filter((p) => p.length);
  const last = paragraphs[paragraphs.length - 1];
  return last ? last[0] : lines[lines.length - 1];
}

function waitingReason(records) {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (isRealPrompt(records[i])) { start = i + 1; break; }
  }
  const turn = records.slice(start);
  const answered = new Set();
  for (const r of turn) if (r.type === 'user') for (const id of toolResultIds(r)) answered.add(id);

  let lastText = null;
  let pendingTool = null;
  let pendingQuestion = null;
  for (const r of turn) {
    if (r.type !== 'assistant' || r.isSidechain || !r.message || !Array.isArray(r.message.content)) continue;
    for (const p of r.message.content) {
      if (!p) continue;
      if (p.type === 'text' && p.text && p.text.trim()) lastText = p.text;
      else if (p.type === 'tool_use' && p.id && !answered.has(p.id)) {
        if (p.name === 'AskUserQuestion') pendingQuestion = p;
        else pendingTool = p;
      }
    }
  }

  if (pendingQuestion) {
    const q = (pendingQuestion.input && Array.isArray(pendingQuestion.input.questions) && pendingQuestion.input.questions[0]) || {};
    const options = Array.isArray(q.options)
      ? q.options.map((o) => clip(o && o.label, OPTION_CAP)).filter(Boolean).slice(0, MAX_OPTIONS)
      : [];
    return { kind: 'question', text: clip(q.question || 'Claude asked a question', REASON_TEXT_CAP), options };
  }
  if (pendingTool) {
    if (pendingTool.name === 'ExitPlanMode') {
      return { kind: 'permission', text: 'ExitPlanMode approve the plan' };
    }
    return { kind: 'permission', text: clip(`${pendingTool.name || 'tool'} ${toolArg(pendingTool.input)}`, PERMISSION_CAP) };
  }
  if (lastText) {
    const line = replyLine(lastText);
    if (line) return { kind: 'reply', text: clip(line, REASON_TEXT_CAP) };
  }
  return null;
}

// One-line body for notifications and the catch-up log.
function reasonText(reason) {
  if (!reason) return 'Claude is waiting for your input';
  if (reason.kind === 'question') {
    const opts = reason.options && reason.options.length ? ` (${reason.options.join(' / ')})` : '';
    return `${reason.text}${opts}`;
  }
  if (reason.kind === 'permission') return `permission: ${reason.text}`;
  return reason.text;
}

// Subagent transcripts live beside the main file; their tokens are real
// spend too. Same incremental scan, usage only.
const subCache = new Map(); // absPath -> { mtimeMs, size, scan, agent, agentFromMeta }

async function scanSubagents(dir) {
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const total = {};
  const totalDays = {};
  const totalChanges = {};
  const agents = [];
  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    count++;
    const abs = path.join(dir, f);
    try {
      const st = await fsp.stat(abs);
      let entry = subCache.get(abs);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        const scan = entry && entry.scan && st.size >= entry.scan.offset
          ? entry.scan
          : { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null, changes: undefined };
        await incrementalScan(abs, st.size, scan);
        // The .meta.json can land minutes to hours after the .jsonl, so keep
        // retrying the read on every rescan until it exists; once read
        // successfully, never re-read it.
        let agent = entry && entry.agent;
        let agentFromMeta = entry ? entry.agentFromMeta : false;
        if (shouldReadMeta(entry)) {
          const r = await readAgentMeta(abs.replace(/\.jsonl$/, '.meta.json'), f);
          agent = r.agent;
          agentFromMeta = r.fromMeta;
        }
        entry = { mtimeMs: st.mtimeMs, size: st.size, scan, agent, agentFromMeta };
        subCache.set(abs, entry);
      }
      mergeUsage(total, entry.scan.usage);
      mergeDays(totalDays, entry.scan.days);
      mergeChanges(totalChanges, entry.scan.changes);
      agents.push({ ...entry.agent, lastWriteAt: entry.mtimeMs });
    } catch {
      /* skip */
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return count ? { usage: total, days: totalDays, changes: totalChanges, count, agents } : null;
}

async function readAgentMeta(metaPath, jsonlName) {
  try {
    const agent = parseAgentMeta(JSON.parse(await fsp.readFile(metaPath, 'utf8')), jsonlName);
    return { agent, fromMeta: true };
  } catch {
    return { agent: parseAgentMeta(null, jsonlName), fromMeta: false };
  }
}

// Pure retry decision for the meta read: retry whenever there's no cache
// entry yet, or the last read didn't come from an actually-parsed meta file.
function shouldReadMeta(entry) {
  return !entry || !entry.agentFromMeta;
}

// Compact live-board summary; tokens rounded to 0.1M so the state
// fingerprint stays stable between scans.
function subagentSummary(meta) {
  if (!meta.subagentCount) return null;
  return {
    count: meta.subagentCount,
    mtok: Math.round(totalTokens(meta.subagentUsage) / 100000) / 10,
  };
}

// How full the context window was on the last turn, rounded so the polled
// state only changes when a displayed figure would. pct is clamped: an
// unknown model gets the 200K default and may read over 100.
function contextSummary(lastContext) {
  if (!lastContext || !lastContext.tokens) return null;
  const window = contextWindow(lastContext.model);
  return {
    tokens: Math.round(lastContext.tokens / 1000) * 1000,
    window,
    pct: Math.min(100, Math.round((lastContext.tokens / window) * 100)),
  };
}

// Tool calls by name with failures, top `top` by count; totals cover all.
function toolSummary(tools, top = 12) {
  const entries = Object.entries(tools || {});
  if (!entries.length) return null;
  let total = 0;
  let errors = 0;
  const byName = entries.map(([name, t]) => {
    total += t.count || 0;
    errors += t.errors || 0;
    return { name, count: t.count || 0, errors: t.errors || 0 };
  });
  byName.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, errors, byName: byName.slice(0, top) };
}

function mergeUsage(target, src) {
  for (const [model, u] of Object.entries(src || {})) {
    const t = target[model] || (target[model] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    t.input += u.input || 0;
    t.output += u.output || 0;
    t.cacheRead += u.cacheRead || 0;
    t.cacheCreation += u.cacheCreation || 0;
  }
  return target;
}

// Main-loop usage plus subagent usage, merged.
function combinedUsage(meta) {
  if (!meta.subagentUsage) return meta.usage || {};
  return mergeUsage(mergeUsage({}, meta.usage), meta.subagentUsage);
}

// Cost breakdown for the transcript viewer, from the meta the collector
// already holds — never re-reads the file. `context` and `tools` are
// filled by the scanner once the context-pressure batch lands.
function usageBreakdown(meta, pricing = null) {
  const combined = combinedUsage(meta || {});
  if (!Object.keys(combined).length) return null;
  const cents = (n) => Math.round(n * 100) / 100;
  const byModel = Object.entries(combined)
    .map(([model, u]) => ({
      model,
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheCreation: u.cacheCreation || 0,
      cost: cents(estimateCost({ [model]: u }, pricing)),
    }))
    .sort((a, b) => b.cost - a.cost);
  const report = costReport(combined, pricing);
  const subs = subagentSummary(meta);
  return {
    cost: cents(report.usd),
    tokens: totalTokens(combined),
    cacheHitRatio: cacheHitRatio(combined),
    byModel,
    subagents: subs
      ? { count: subs.count, cost: cents(estimateCost(meta.subagentUsage, pricing)), tokens: totalTokens(meta.subagentUsage) }
      : null,
    assumedModels: report.assumedModels,
    context: contextSummary(meta.context),
    tools: toolSummary(meta.tools),
  };
}

function mergeDays(target, src) {
  for (const [day, byModel] of Object.entries(src || {})) {
    target[day] = mergeUsage(target[day] || {}, byModel);
  }
  return target;
}

// Main-loop day buckets plus subagent day buckets, merged.
function combinedDays(meta) {
  if (!meta.subagentDays) return meta.days || {};
  return mergeDays(mergeDays({}, meta.days), meta.subagentDays);
}

// Sum per-session day buckets into a chartable series: one entry per local
// day for the trailing numDays window ending today, zero-filled.
function dailyCostSeries(daysList, numDays, today = Date.now(), pricing = null) {
  const merged = {};
  for (const d of daysList) mergeDays(merged, d);
  const now = new Date(today);
  const series = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const usage = merged[dayKey(d.getTime())] || {};
    series.push({
      t: d.getTime(),
      cost: Math.round(estimateCost(usage, pricing) * 100) / 100,
      tokens: totalTokens(usage),
    });
  }
  return series;
}

// Best display title for a session, with its provenance.
// `custom` is a user-set name from config.json (sessionNames); it wins over
// anything derived from the transcript.
function sessionTitle(meta, customNames) {
  const custom = customNames && customNames[meta.sessionId];
  if (custom) return { title: custom, source: 'custom' };
  if (meta.aiTitle) return { title: meta.aiTitle, source: 'ai-title' };
  if (meta.firstUserPrompt) return { title: meta.firstUserPrompt, source: 'first-prompt' };
  if (meta.lastPrompt) return { title: meta.lastPrompt, source: 'last-prompt' };
  return { title: meta.sessionId.slice(0, 8), source: 'session-id' };
}

// Group scanned sessions by canonical project root (worktrees fold in).
function groupByProject(sessions) {
  const byProject = new Map(); // lowercase root -> { path, sessions: [] }
  for (const meta of sessions) {
    if (!meta.cwd) continue; // can't place it without a real path
    const { root, worktree } = worktreeRoot(meta.cwd);
    const key = root.toLowerCase();
    let e = byProject.get(key);
    if (!e) {
      e = { path: root, sessions: [] };
      byProject.set(key, e);
    }
    e.sessions.push({ ...meta, worktree, projectPath: root });
  }
  for (const e of byProject.values()) {
    e.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
  return byProject;
}

module.exports = {
  scanAllTranscripts, scanFile, groupByProject, sessionTitle, combinedUsage, mergeUsage,
  scanLine, mergeDays, combinedDays, dailyCostSeries, subagentSummary, usageBreakdown, dayKey, contextSummary, toolSummary,
  waitingReason, reasonText, shouldReadMeta, TOOL_RING,
};
