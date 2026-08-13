'use strict';
// Usage/quota widget data from ~/.claude/.statusline-usage-cache (KEY=VALUE).
const fs = require('fs/promises');
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const CACHE_FILE = path.join(CLAUDE_DIR, '.statusline-usage-cache');
const STALE_MS = 2 * 60 * 60 * 1000; // statusline only updates while Claude runs

async function readQuota() {
  let raw;
  try {
    raw = await fs.readFile(CACHE_FILE, 'utf8');
  } catch {
    return null;
  }
  const kv = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const ts = Number(kv.TIMESTAMP) || 0;
  // TIMESTAMP may be epoch seconds or ms; normalize to ms.
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  return {
    utilization: num(kv.UTILIZATION),
    weeklyUtilization: num(kv.WEEKLY_UTILIZATION),
    costUsed: num(kv.COST_USED),
    costLimit: num(kv.COST_LIMIT),
    currency: kv.COST_CURRENCY || 'USD',
    resetsAt: kv.RESETS_AT || null,
    weeklyResetsAt: kv.WEEKLY_RESETS_AT || null,
    profileName: kv.PROFILE_NAME || null,
    stale: !tsMs || Date.now() - tsMs > STALE_MS,
  };
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { readQuota };
