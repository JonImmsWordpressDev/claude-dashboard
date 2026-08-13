'use strict';
// Usage meters via Anthropic's OAuth usage endpoint, authenticated with the
// same Keychain credentials Claude Code itself uses. The token lives in
// memory only — never written, never logged. macOS only (Keychain); other
// platforms fall back to the statusline cache in quota.js.
//
// This is the dashboard's one automatic network call, to Anthropic only,
// for the account's own usage numbers. Toggle: config.usageApi.
const { execFile } = require('child_process');
const { readConfig } = require('./config');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TTL_MS = 5 * 60 * 1000; // be polite: at most one call per 5 min

let tokenCache = { token: null, expiresAt: 0 };
let usageCache = { at: 0, quota: null };

function readKeychainToken() {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const oauth = JSON.parse(stdout).claudeAiOauth;
          if (oauth && oauth.accessToken) {
            resolve({ token: oauth.accessToken, expiresAt: oauth.expiresAt || 0 });
            return;
          }
        } catch { /* fall through */ }
        resolve(null);
      }
    );
  });
}

async function getToken(forceReread) {
  const now = Date.now();
  // Claude Code refreshes the Keychain item as it runs; re-read when ours
  // is missing, near expiry, or a request just got a 401.
  if (forceReread || !tokenCache.token || now > tokenCache.expiresAt - 60_000) {
    const fresh = await readKeychainToken();
    if (fresh) tokenCache = fresh;
    else if (forceReread) tokenCache = { token: null, expiresAt: 0 };
  }
  return tokenCache.token;
}

function normalize(body) {
  const five = body.five_hour || {};
  const week = body.seven_day || {};
  const extra = body.extra_usage || {};
  const scale = Math.pow(10, extra.decimal_places ?? 2);
  return {
    utilization: typeof five.utilization === 'number' ? five.utilization : null,
    weeklyUtilization: typeof week.utilization === 'number' ? week.utilization : null,
    resetsAt: five.resets_at || null,
    weeklyResetsAt: week.resets_at || null,
    costUsed: typeof extra.used_credits === 'number' ? extra.used_credits / scale : null,
    costLimit: typeof extra.monthly_limit === 'number' ? extra.monthly_limit / scale : null,
    currency: extra.currency || 'USD',
    extraUsageEnabled: extra.is_enabled === true,
    stale: false,
    source: 'api',
  };
}

async function requestUsage(token) {
  const r = await fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-dashboard',
    },
  });
  if (!r.ok) {
    const e = new Error(`usage endpoint ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return normalize(await r.json());
}

// Returns a quota object, or null (caller falls back to the file cache).
async function fetchOauthUsage() {
  if (process.platform !== 'darwin') return null;
  if (readConfig().usageApi === false) return null;
  const now = Date.now();
  if (usageCache.quota && now - usageCache.at < FETCH_TTL_MS) return usageCache.quota;

  try {
    let token = await getToken(false);
    if (!token) return null;
    let quota;
    try {
      quota = await requestUsage(token);
    } catch (e) {
      if (e.status !== 401) throw e;
      token = await getToken(true); // stale token — re-read Keychain once
      if (!token) return null;
      quota = await requestUsage(token);
    }
    usageCache = { at: now, quota };
    return quota;
  } catch {
    // Keep serving the last good numbers briefly; mark stale past the TTL.
    if (usageCache.quota && now - usageCache.at < 3 * FETCH_TTL_MS) {
      return { ...usageCache.quota, stale: true };
    }
    return null;
  }
}

module.exports = { fetchOauthUsage };
