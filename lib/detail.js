'use strict';
// On-demand project detail: CLAUDE.md files, per-project memory, skills/
// agents/commands, and settings. Read-only; every read is confined to the
// project root or that project's memory dir under ~/.claude.
const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR, canonicalize, encodeProjectDir } = require('./paths');

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

// Skills are directories containing SKILL.md; agents/commands are .md files.
async function collectCapabilities(root) {
  const base = path.join(root, '.claude');
  const out = { skills: [], agents: [], commands: [] };

  try {
    for (const entry of await fsp.readdir(path.join(base, 'skills'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = await readCapped(path.join(base, 'skills', entry.name, 'SKILL.md'));
      out.skills.push({
        name: entry.name,
        description: skillMd ? frontmatterDescription(skillMd.content) : null,
        content: skillMd ? skillMd.content : null,
      });
    }
  } catch { /* no skills dir */ }

  for (const kind of ['agents', 'commands']) {
    for (const name of await listMd(path.join(base, kind))) {
      const file = await readCapped(path.join(base, kind, name));
      out[kind].push({
        name: name.replace(/\.md$/, ''),
        description: file ? frontmatterDescription(file.content) : null,
        content: file ? file.content : null,
      });
    }
  }
  return out;
}

async function collectSettings(root) {
  const out = {};
  for (const [key, rel] of [
    ['settings', '.claude/settings.json'],
    ['settingsLocal', '.claude/settings.local.json'],
    ['mcpJson', '.mcp.json'],
  ]) {
    const f = await readCapped(path.join(root, rel));
    if (f) out[key] = f.content;
  }
  // Per-project entry in Claude's own registry: MCP servers + allowed tools.
  try {
    const reg = JSON.parse(await fsp.readFile(path.join(CLAUDE_DIR, '..', '.claude.json'), 'utf8'));
    for (const [p, info] of Object.entries(reg.projects || {})) {
      if (canonicalize(p).toLowerCase() !== canonicalize(root).toLowerCase()) continue;
      if (info.mcpServers && Object.keys(info.mcpServers).length) {
        out.mcpServers = Object.keys(info.mcpServers);
      }
      if (Array.isArray(info.allowedTools) && info.allowedTools.length) {
        out.allowedTools = info.allowedTools;
      }
      break;
    }
  } catch { /* registry unreadable */ }
  return out;
}

async function collectMemory(root) {
  const memDir = path.join(CLAUDE_DIR, 'projects', encodeProjectDir(root), 'memory');
  const files = [];
  for (const name of await listMd(memDir)) {
    const f = await readCapped(path.join(memDir, name));
    if (f) files.push({ name, content: f.content, mtimeMs: f.mtimeMs });
  }
  // MEMORY.md (the index) first, then newest first.
  files.sort((a, b) =>
    a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : b.mtimeMs - a.mtimeMs
  );
  return files;
}

async function projectDetail(root) {
  const claudeMd = [];
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
    const f = await readCapped(path.join(root, name));
    if (f) claudeMd.push({ name, content: f.content });
  }
  const [capabilities, settings, memory] = await Promise.all([
    collectCapabilities(root),
    collectSettings(root),
    collectMemory(root),
  ]);
  return { path: root, claudeMd, memory, ...capabilities, settings };
}

module.exports = { projectDetail };
