'use strict';
// Session transcript metadata from ~/.claude/projects/<enc>/<sessionId>.jsonl.
// Files reach 14MB; never full-parse. Read head (cwd/branch/first prompt),
// tail (last-prompt / away_summary), and one streaming substring pass for the
// last ai-title. Cached by (mtime, size).
const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR, worktreeRoot } = require('./paths');
const { estimateCost, totalTokens } = require('./pricing');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 16 * 1024;

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
    : { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null, lastModel: null };

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

  // Tail: last complete lines carry last-prompt / away_summary.
  const tailLines = tail.split('\n').filter((l) => l.trim());
  for (let i = tailLines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(tailLines[i]);
    } catch {
      continue; // first tail line is usually a partial record
    }
    if (meta.lastPrompt === null && rec.type === 'last-prompt' && rec.lastPrompt) {
      meta.lastPrompt = String(rec.lastPrompt).slice(0, 200);
    }
    if (meta.awaySummary === null && rec.type === 'system' && rec.subtype === 'away_summary' && rec.content) {
      meta.awaySummary = String(rec.content).slice(0, 800);
      const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      meta.awaySummaryAt = Number.isNaN(t) ? null : t;
    }
  }

  await incrementalScan(abs, st.size, scan);
  meta.aiTitle = scan.aiTitle;
  meta.usage = scan.usage;
  meta.days = scan.days;
  meta.waits = scan.waits || null;
  meta.model = scan.lastModel || null;

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
      if (m.id && m.id === scan.lastMsgId) return;
      scan.lastMsgId = m.id || null;
      const model = m.model || 'unknown';
      scan.lastModel = model; // most recent real model = the session's model
      addUsage(scan.usage, model, m.usage);
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

// Subagent transcripts live beside the main file; their tokens are real
// spend too. Same incremental scan, usage only.
const subCache = new Map(); // absPath -> { mtimeMs, size, scan }

async function scanSubagents(dir) {
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const total = {};
  const totalDays = {};
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
          : { offset: 0, aiTitle: null, usage: {}, days: {}, lastMsgId: null };
        await incrementalScan(abs, st.size, scan);
        entry = { mtimeMs: st.mtimeMs, size: st.size, scan };
        subCache.set(abs, entry);
      }
      mergeUsage(total, entry.scan.usage);
      mergeDays(totalDays, entry.scan.days);
    } catch {
      /* skip */
    }
  }
  return count ? { usage: total, days: totalDays, count } : null;
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
function dailyCostSeries(daysList, numDays, today = Date.now()) {
  const merged = {};
  for (const d of daysList) mergeDays(merged, d);
  const now = new Date(today);
  const series = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const usage = merged[dayKey(d.getTime())] || {};
    series.push({
      t: d.getTime(),
      cost: Math.round(estimateCost(usage) * 100) / 100,
      tokens: totalTokens(usage),
    });
  }
  return series;
}

// Best display title for a session, with its provenance.
function sessionTitle(meta) {
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
  scanAllTranscripts, groupByProject, sessionTitle, combinedUsage, mergeUsage,
  scanLine, mergeDays, combinedDays, dailyCostSeries, subagentSummary, dayKey,
};
