'use strict';
// Plan detection from Claude Code's own local account cache
// (~/.claude.json -> oauthAccount). Local-only; no tokens are read.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

let cache = { mtimeMs: 0, plan: null };

const TYPE_LABELS = {
  claude_max: 'Max',
  claude_pro: 'Pro',
  claude_free: 'Free',
  claude_team: 'Team',
  claude_enterprise: 'Enterprise',
};

function planLabel(orgType, tier) {
  const base = TYPE_LABELS[orgType] || (orgType ? orgType.replace(/^claude_/, '') : null);
  if (!base) return null;
  const mult = tier && tier.match(/_(\d+x)$/);
  return mult ? `${base} ${mult[1]}` : base;
}

function readPlan() {
  let st;
  try {
    st = fs.statSync(CLAUDE_JSON);
  } catch {
    return null;
  }
  if (st.mtimeMs === cache.mtimeMs) return cache.plan;
  let plan = null;
  try {
    const oa = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')).oauthAccount;
    if (oa && (oa.organizationType || oa.emailAddress)) {
      plan = {
        label: planLabel(oa.organizationType, oa.organizationRateLimitTier) || 'unknown',
        tier: oa.userRateLimitTier || oa.organizationRateLimitTier || null,
        organization: oa.organizationName || null,
        email: oa.emailAddress || null,
        extraUsage: oa.hasExtraUsageEnabled === true,
        billing: oa.billingType || null,
      };
    } else {
      // No OAuth account cached — likely API-key auth.
      plan = { label: 'API', tier: null, organization: null, email: null, extraUsage: false, billing: 'api' };
    }
  } catch {
    /* keep null */
  }
  cache = { mtimeMs: st.mtimeMs, plan };
  return plan;
}

module.exports = { readPlan, planLabel };
