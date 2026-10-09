'use strict';
// Estimated cost from token usage at Anthropic list rates (USD per MTok).
// Cache write = 1.25x input. Cache read = 0.1x input unless the row sets
// `cacheRead` (Fable and Opus 5.5 price cache reads below the usual tenth).
// List-price estimates: on a subscription they show relative weight, not
// billed dollars. Rates cached 2026-10-06; matched by id prefix, most
// specific first. Haiku 5.5's >100K-prompt tier ($0.50 / $2.50) is ignored.
const RATES = [
  { prefix: 'claude-fable-5', input: 10, output: 50, cacheRead: 0.25 }, // 5 and 5-1
  { prefix: 'claude-mythos', input: 10, output: 50, cacheRead: 0.25 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
  { prefix: 'claude-opus-4-1', input: 15, output: 75 },
  { prefix: 'claude-opus-4-0', input: 15, output: 75 },
  { prefix: 'claude-opus-4-2025', input: 15, output: 75 },
  { prefix: 'claude-opus', input: 5, output: 25 }, // 4-5 … 4-8
  { prefix: 'claude-sonnet-5', input: 2, output: 10 }, // 5 and 5-5
  { prefix: 'claude-sonnet', input: 3, output: 15 }, // 4-6 and older
  { prefix: 'claude-haiku-5', input: 0.1, output: 0.5 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4 },
  { prefix: 'claude-haiku', input: 1, output: 5 },
];
const DEFAULT_RATE = { input: 5, output: 25 }; // unknown model: assume opus-tier

// Bare family aliases that some transcript records carry instead of an id.
const ALIASES = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

function normalizeModel(model) {
  const m = String(model || '');
  return Object.hasOwn(ALIASES, m) ? ALIASES[m] : m;
}

function expandRate(r, assumed) {
  return {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead !== undefined ? r.cacheRead : r.input * 0.1,
    cacheWrite: r.input * 1.25,
    assumed,
  };
}

const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Contracted or self-supplied rates in the shape of Claude Code's managed
// `modelPricing` setting: { multiplier, overrides: { [modelId]: { input,
// output, cacheRead, cacheWrite } } }, USD per MTok. The higher-precedence
// source (managed settings, then our config.json) wins whole. Validation
// mirrors Claude Code: a bad multiplier is ignored, a bad row is dropped
// and the rest kept, nothing throws.
function loadPricing(managedRaw, configRaw) {
  const pick = (raw, source) => {
    if (!raw || typeof raw !== 'object') return null;
    const table = { multiplier: 1, overrides: Object.create(null), source };
    if (typeof raw.multiplier === 'number' && raw.multiplier > 0 && raw.multiplier <= 10) {
      table.multiplier = raw.multiplier;
    }
    const overrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
    for (const [id, row] of Object.entries(overrides)) {
      if (id === '__proto__' || !row || typeof row !== 'object') continue;
      const ok = RATE_KEYS.every((k) => typeof row[k] === 'number' && row[k] >= 0 && row[k] <= 10000);
      if (ok) table.overrides[id] = { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite };
    }
    return table;
  };
  return pick(managedRaw, 'managed') || pick(configRaw, 'config') || { multiplier: 1, overrides: {}, source: null };
}

// Provider-specific ids (us.anthropic.claude-x-v1:0, claude-x@20260101)
// reduce to the built-in id so a row keyed by that id covers them.
function baseModelId(model) {
  return normalizeModel(model)
    .replace(/^([a-z]+\.)*anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@.*$/, '');
}

// Exact key first; then the bare built-in id; then a built-in id row
// covers its dated snapshots. Keys that aren't built-in ids match exactly.
function overrideFor(model, pricing) {
  if (!pricing || !pricing.overrides) return null;
  const m = normalizeModel(model);
  if (Object.hasOwn(pricing.overrides, m)) return pricing.overrides[m];
  const base = baseModelId(m);
  if (Object.hasOwn(pricing.overrides, base)) return pricing.overrides[base];
  for (const [key, row] of Object.entries(pricing.overrides)) {
    if (key.startsWith('claude-') && base.startsWith(key + '-20')) return row;
  }
  return null;
}

// -> { input, output, cacheRead, cacheWrite, assumed }, USD per MTok.
// `assumed` is true when the id matched nothing and the opus-tier
// fallback is in use — the UI flags those so a stale table is visible.
function rateFor(model, pricing = null) {
  const o = overrideFor(model, pricing);
  let base;
  if (o) base = { ...o, assumed: false };
  else {
    const m = baseModelId(model);
    const row = RATES.find((r) => m.startsWith(r.prefix));
    base = row ? expandRate(row, false) : expandRate(DEFAULT_RATE, true);
  }
  const mult = pricing && pricing.multiplier ? pricing.multiplier : 1;
  return {
    input: base.input * mult,
    output: base.output * mult,
    cacheRead: base.cacheRead * mult,
    cacheWrite: base.cacheWrite * mult,
    assumed: base.assumed,
  };
}

// usageByModel: { [model]: {input, output, cacheRead, cacheCreation} } (token counts)
// -> { usd, assumedModels } where assumedModels lists ids priced at the fallback.
function costReport(usageByModel, pricing = null) {
  let usd = 0;
  const assumed = new Set();
  for (const [model, u] of Object.entries(usageByModel || {})) {
    const r = rateFor(model, pricing);
    if (r.assumed) assumed.add(model);
    usd +=
      ((u.input || 0) * r.input +
        (u.output || 0) * r.output +
        (u.cacheRead || 0) * r.cacheRead +
        (u.cacheCreation || 0) * r.cacheWrite) /
      1_000_000;
  }
  return { usd, assumedModels: [...assumed].sort() };
}

function estimateCost(usageByModel, pricing = null) {
  return costReport(usageByModel, pricing).usd;
}

function totalTokens(usageByModel) {
  let t = 0;
  for (const u of Object.values(usageByModel || {})) {
    t += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
  }
  return t;
}

// Highest budget threshold crossed (0, 75, 90, or 100), for one-shot alerts.
function budgetLevel(spent, budget) {
  if (!budget || budget <= 0) return 0;
  const pct = (spent / budget) * 100;
  if (pct >= 100) return 100;
  if (pct >= 90) return 90;
  if (pct >= 75) return 75;
  return 0;
}

// Median response-time bucket as a label, from [<30s, <2m, <10m, <=30m] counts.
const WAIT_LABELS = ['under 30s', 'under 2m', 'under 10m', 'under 30m'];
function typicalWait(buckets) {
  const total = (buckets || []).reduce((a, b) => a + b, 0);
  if (!total) return null;
  let cum = 0;
  for (let i = 0; i < buckets.length; i++) {
    cum += buckets[i];
    if (cum * 2 >= total) return WAIT_LABELS[i];
  }
  return null;
}

// Whole dollars per hour for a running session, null under $1/h. Null for the
// first five minutes too: one turn in a fresh session would otherwise read as
// hundreds per hour. Whole dollars because a cents figure drifts with the clock
// and would churn the SSE state fingerprint on every poll.
const BURN_MIN_MS = 5 * 60 * 1000;
function burnRate(usd, startedAt, now = Date.now()) {
  if (!usd || !startedAt) return null;
  const ms = now - startedAt;
  if (ms < BURN_MIN_MS) return null;
  const perHour = Math.round(usd / (ms / 3600000));
  return perHour >= 1 ? perHour : null;
}

// Share of input-side tokens served from the prompt cache, 0..1.
// Null when the session has no input-side tokens at all.
function cacheHitRatio(usageByModel) {
  let read = 0;
  let all = 0;
  for (const u of Object.values(usageByModel || {})) {
    read += u.cacheRead || 0;
    all += (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
  }
  return all ? read / all : null;
}

// Top n by `.cost`, descending; entries under a cent are noise.
function topByCost(items, n = 10) {
  return [...items].filter((i) => i.cost >= 0.01).sort((a, b) => b.cost - a.cost).slice(0, n);
}

// Context window per model, for the "how full is it" meter. Every Claude
// 5.x model and Opus/Sonnet 4.6+ is 1M; Haiku 4.5 and older are 200K.
// Unknown ids get 200K: an over-full meter on an unknown model is a
// visible prompt to update, a falsely empty one is not.
const MILLION_WINDOW = [
  'claude-fable-5', 'claude-mythos', 'claude-opus-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5',
];
function contextWindow(model) {
  const id = baseModelId(model);
  return MILLION_WINDOW.some((p) => id.startsWith(p)) ? 1_000_000 : 200_000;
}

module.exports = { estimateCost, costReport, totalTokens, rateFor, normalizeModel, loadPricing, overrideFor, budgetLevel, typicalWait, burnRate, cacheHitRatio, topByCost, contextWindow };
