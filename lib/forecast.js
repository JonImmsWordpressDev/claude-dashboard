'use strict';
// Limit forecast: project the 5-hour and weekly usage meters forward and
// say when they will hit 100%, if that comes before the window resets.
//
// Pace comes from recent samples when we have enough history, otherwise
// from the average since the window opened (resetsAt - window length) —
// so a fresh server start still has a forecast.

const WINDOWS = {
  session: { windowMs: 5 * 3600_000, lookbackMs: 30 * 60_000, minElapsedMs: 15 * 60_000 },
  week: { windowMs: 7 * 24 * 3600_000, lookbackMs: 24 * 3600_000, minElapsedMs: 6 * 3600_000 },
};
const SAMPLE_GAP_MS = 5 * 60_000; // the usage API is polled at most every 5 min
const ROUND_MS = 5 * 60_000; // keep hitAt stable between polls
const ALERT_MIN_PCT = 50; // don't alarm on early, noisy extrapolation

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Returns a new samples array with this reading added. A changed resetsAt
// or a drop in utilization means a new window: start over.
function recordSample(samples, utilization, resetsAt, now, keepMs) {
  if (utilization == null) return samples;
  const reset = toMs(resetsAt);
  let out = samples.filter((s) => s.resetsAt === reset && now - s.at <= keepMs);
  const last = out[out.length - 1];
  if (last && utilization < last.utilization) out = [];
  else if (last && now - last.at < SAMPLE_GAP_MS) return out;
  out.push({ at: now, utilization, resetsAt: reset });
  return out;
}

// { hitAt, projected, resetsAt, utilization, basis } or null when there is
// nothing sensible to say. hitAt is null when the window resets first.
function forecastWindow({ utilization, resetsAt, windowMs, lookbackMs, minElapsedMs, samples = [], now = Date.now() }) {
  const reset = toMs(resetsAt);
  if (utilization == null || !reset || reset <= now) return null;

  let rate = null; // percentage points per ms
  let basis = 'recent';
  const mine = samples.filter((s) => s.resetsAt === reset && s.at < now);
  let anchor = null;
  for (const s of mine) if (s.at <= now - lookbackMs) anchor = s;
  if (!anchor && mine.length && now - mine[0].at >= lookbackMs / 2) anchor = mine[0];
  if (anchor) rate = Math.max(0, (utilization - anchor.utilization) / (now - anchor.at));

  if (rate == null) {
    const elapsed = now - (reset - windowMs);
    if (elapsed < minElapsedMs) return null;
    rate = utilization / elapsed;
    basis = 'average';
  }

  const projected = Math.min(999, Math.round(utilization + rate * (reset - now)));
  let hitAt = null;
  if (utilization >= 100) hitAt = Math.floor(now / ROUND_MS) * ROUND_MS;
  else if (rate > 0) {
    const t = now + (100 - utilization) / rate;
    if (t < reset) hitAt = Math.floor(t / ROUND_MS) * ROUND_MS;
  }
  return { hitAt, projected, resetsAt: reset, utilization, basis };
}

// True when this forecast deserves a notification we haven't sent yet for
// this window. alertedFor is the resetsAt we last alerted on.
function shouldAlert(f, alertedFor) {
  return !!(f && f.hitAt && f.utilization < 100 && f.utilization >= ALERT_MIN_PCT && f.resetsAt !== alertedFor);
}

// "around 3:40 PM" today, "Thu around 2:15 PM" on another day.
function clockLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return `around ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} around ${time}`;
}

// "35m", "1h 10m", "2d 4h".
function durationLabel(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

module.exports = { WINDOWS, toMs, recordSample, forecastWindow, shouldAlert, clockLabel, durationLabel };
