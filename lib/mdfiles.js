'use strict';
// Small readers for the markdown-file conventions Claude Code uses:
// agents are `<dir>/<name>.md`, skills are `<dir>/<name>/SKILL.md`, both
// with YAML frontmatter carrying a `description:`. Everything here is
// read-only and tolerant: a missing or unreadable directory lists as [].
const fsp = require('fs/promises');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024; // per-file cap for returned content

async function readCapped(abs) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return null;
    const fh = await fsp.open(abs, 'r');
    try {
      const len = Math.min(st.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      let content = buf.toString('utf8');
      if (st.size > MAX_FILE_BYTES) content += `\n\n… truncated (${st.size} bytes total)`;
      return { content, size: st.size, mtimeMs: st.mtimeMs };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function listMd(dir) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

// First `description:` line of YAML frontmatter, if any.
function frontmatterDescription(content) {
  if (!content || !content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const m = content.slice(0, end).match(/^description:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 300) : null;
}

// Agents: one `.md` per agent, name = filename without extension.
async function listAgents(dir) {
  const out = [];
  for (const name of await listMd(dir)) {
    const file = await readCapped(path.join(dir, name));
    out.push({ name: name.replace(/\.md$/, ''), description: file ? frontmatterDescription(file.content) : null });
  }
  return out;
}

// Skills: one directory per skill containing SKILL.md.
async function listSkills(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = await readCapped(path.join(dir, entry.name, 'SKILL.md'));
    if (!skillMd) continue;
    out.push({ name: entry.name, description: frontmatterDescription(skillMd.content) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = { readCapped, listMd, frontmatterDescription, listAgents, listSkills, MAX_FILE_BYTES };
