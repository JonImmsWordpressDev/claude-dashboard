'use strict';
// Estimated cost from token usage, at Anthropic list rates (USD per MTok).
// Cache read = 0.1x input; cache write = 1.25x input (5-minute TTL).
// These are list-price estimates — on a Max plan they show relative weight,
// not billed dollars. Rates cached 2026-08; matched by id prefix.
const RATES = [
  { prefix: 'claude-fable-5', input: 10, output: 50 },
  { prefix: 'claude-mythos', input: 10, output: 50 },
  { prefix: 'claude-opus-4-1', input: 15, output: 75 },
  { prefix: 'claude-opus-4-0', input: 15, output: 75 },
  { prefix: 'claude-opus-4-2025', input: 15, output: 75 },
  { prefix: 'claude-opus', input: 5, output: 25 }, // opus-5, 4-8, 4-7, 4-6, 4-5
  { prefix: 'claude-sonnet', input: 3, output: 15 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4 },
  { prefix: 'claude-haiku', input: 1, output: 5 },
];
const DEFAULT_RATE = { input: 5, output: 25 }; // unknown model: assume opus-tier

function rateFor(model) {
  const m = String(model || '');
  for (const r of RATES) if (m.startsWith(r.prefix)) return r;
  return DEFAULT_RATE;
}

// usageByModel: { [model]: {input, output, cacheRead, cacheCreation} } (token counts)
function estimateCost(usageByModel) {
  let usd = 0;
  for (const [model, u] of Object.entries(usageByModel || {})) {
    const r = rateFor(model);
    usd +=
      ((u.input || 0) * r.input +
        (u.output || 0) * r.output +
        (u.cacheRead || 0) * r.input * 0.1 +
        (u.cacheCreation || 0) * r.input * 1.25) /
      1_000_000;
  }
  return usd;
}

function totalTokens(usageByModel) {
  let t = 0;
  for (const u of Object.values(usageByModel || {})) {
    t += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
  }
  return t;
}

module.exports = { estimateCost, totalTokens, rateFor };
