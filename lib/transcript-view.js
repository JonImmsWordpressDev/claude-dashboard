'use strict';
// Full transcript of one session, parsed into displayable turns.
// Cursor-based: pass back `nextOffset` to read only what was appended since —
// that's what powers live-follow in the UI.
const fsp = require('fs/promises');

const MAX_EVENTS = 1200; // initial load keeps the newest N turns
const USER_CAP = 4000;
const ASSISTANT_CAP = 8000;
const TOOL_INPUT_CAP = 240;

function toolInputSummary(input) {
  if (!input || typeof input !== 'object') return '';
  // The most readable single field wins; else compact JSON.
  for (const key of ['command', 'description', 'file_path', 'prompt', 'query', 'url', 'skill']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key].replace(/\s+/g, ' ').slice(0, TOOL_INPUT_CAP);
    }
  }
  try {
    return JSON.stringify(input).slice(0, TOOL_INPUT_CAP);
  } catch {
    return '';
  }
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const p of content) {
    if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function isHarnessNoise(text) {
  const t = text.trimStart();
  return (
    t.startsWith('<system-reminder>') ||
    t.startsWith('<local-command') ||
    t.startsWith('<command-') ||
    t.startsWith('[SYSTEM NOTIFICATION') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('Base directory for this skill')
  );
}

function parseLine(line, events) {
  if (!line.trim()) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;

  if (rec.type === 'user' && rec.message && !rec.isSidechain) {
    const text = userText(rec.message.content);
    if (text && text.trim() && !isHarnessNoise(text)) {
      events.push({ kind: 'user', text: text.slice(0, USER_CAP), truncated: text.length > USER_CAP, ts });
    }
    return;
  }

  if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content) && !rec.isSidechain) {
    for (const part of rec.message.content) {
      if (!part) continue;
      if (part.type === 'text' && part.text && part.text.trim()) {
        events.push({ kind: 'assistant', text: part.text.slice(0, ASSISTANT_CAP), truncated: part.text.length > ASSISTANT_CAP, ts });
      } else if (part.type === 'tool_use') {
        events.push({ kind: 'tool', name: part.name || 'tool', input: toolInputSummary(part.input), ts });
      }
    }
    return;
  }

  if (rec.type === 'system' && rec.subtype === 'away_summary' && rec.content) {
    events.push({ kind: 'note', text: String(rec.content).slice(0, ASSISTANT_CAP), ts });
  }
}

// Read complete lines from `fromOffset` to EOF; a trailing partial line is
// left for the next call.
async function readNewLines(file, fromOffset) {
  const st = await fsp.stat(file);
  if (st.size <= fromOffset) return { lines: [], nextOffset: fromOffset };
  const fh = await fsp.open(file, 'r');
  try {
    const len = st.size - fromOffset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fromOffset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return { lines: [], nextOffset: fromOffset };
    return {
      lines: buf.subarray(0, lastNl + 1).toString('utf8').split('\n'),
      nextOffset: fromOffset + lastNl + 1,
    };
  } finally {
    await fh.close();
  }
}

async function sessionTranscript(file, fromOffset = 0) {
  const { lines, nextOffset } = await readNewLines(file, fromOffset);
  const events = [];
  for (const line of lines) parseLine(line, events);
  let truncatedTurns = 0;
  if (fromOffset === 0 && events.length > MAX_EVENTS) {
    truncatedTurns = events.length - MAX_EVENTS;
    events.splice(0, truncatedTurns);
  }
  return { events, truncatedTurns, nextOffset };
}

module.exports = { sessionTranscript };
