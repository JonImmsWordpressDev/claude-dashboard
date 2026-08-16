'use strict';
// Claude.ai chats, imported from the official data export
// (claude.ai → Settings → Privacy → Export data → conversations.json).
// Stored normalized and slimmed in the config dir as chats.json —
// read-only afterwards, refreshed by mtime like every other user file.
const fs = require('fs');
const path = require('path');
const { configDir } = require('./config');

const CHATS_FILE = path.join(configDir(), 'chats.json');

// The export replaces artifacts/rich blocks with this placeholder — drop it.
const PLACEHOLDER = /^This block is not supported on your current device yet\.?$/;

function msgText(m) {
  if (m.text && m.text.trim()) return m.text.trim();
  const parts = (m.content || [])
    .filter((p) => p && p.type === 'text' && p.text && p.text.trim() && !PLACEHOLDER.test(p.text.trim()))
    .map((p) => p.text.trim());
  return parts.join('\n\n');
}

// Raw export array -> slim [{id, name, createdAt, updatedAt, count, messages}]
function normalizeChats(raw) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const messages = (c.chat_messages || [])
      .map((m) => ({
        who: m.sender === 'human' ? 'you' : 'claude',
        text: msgText(m),
        ts: m.created_at ? Date.parse(m.created_at) || null : null,
      }))
      .filter((m) => m.text);
    if (!messages.length) continue;
    const name = (c.name || '').trim() || messages[0].text.slice(0, 80);
    out.push({
      id: c.uuid,
      name,
      createdAt: Date.parse(c.created_at) || null,
      updatedAt: Date.parse(c.updated_at) || Date.parse(c.created_at) || 0,
      count: messages.length,
      messages,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

const MAX_RESULTS = 40;
function searchChats(q, chats) {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const c of chats || []) {
    if (out.length >= MAX_RESULTS) break;
    if (c.name.toLowerCase().includes(needle)) {
      out.push({ chatId: c.id, name: c.name, snippet: c.name, ts: c.updatedAt });
      continue;
    }
    for (const m of c.messages || []) {
      const i = m.text.toLowerCase().indexOf(needle);
      if (i === -1) continue;
      const start = Math.max(0, i - 60);
      out.push({
        chatId: c.id,
        name: c.name,
        snippet: (start > 0 ? '…' : '') + m.text.slice(start, i + needle.length + 140).replace(/\s+/g, ' '),
        ts: m.ts || c.updatedAt,
      });
      break;
    }
  }
  return out;
}

// Cached by mtime, like config.json.
let cache = { mtimeMs: 0, chats: [] };
function readChats() {
  let st;
  try {
    st = fs.statSync(CHATS_FILE);
  } catch {
    return [];
  }
  if (st.mtimeMs !== cache.mtimeMs) {
    try {
      cache = { mtimeMs: st.mtimeMs, chats: JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) };
    } catch {
      cache = { mtimeMs: st.mtimeMs, chats: [] };
    }
  }
  return cache.chats;
}

// Normalize the raw export and persist. Returns the imported count.
function saveChats(raw) {
  const chats = normalizeChats(raw);
  fs.writeFileSync(CHATS_FILE, JSON.stringify(chats));
  cache = { mtimeMs: 0, chats: [] }; // next read picks up the new file
  return chats.length;
}

module.exports = { normalizeChats, searchChats, readChats, saveChats };
