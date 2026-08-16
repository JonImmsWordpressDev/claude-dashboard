'use strict';
// CLAUDE_DASH_DEMO=1: serve believable fake data instead of reading ~/.claude.
// For screenshots, demos, and trying the dashboard without any Claude history.
// Times are computed relative to now on every call so the board looks alive.

const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const S1 = 'demo1111-1111-4111-8111-111111111111';
const S2 = 'demo2222-2222-4222-8222-222222222222';
const S3 = 'demo3333-3333-4333-8333-333333333333';

function demoState() {
  const now = Date.now();
  const mk = (name, path, ago, git, spark, spend) => ({
    path,
    name,
    lastActivityAt: now - ago,
    isLive: ago < 5 * MIN,
    git,
    spend7d: spend,
    activity: { counts: spark },
    sessions: [],
  });
  return {
    generatedAt: now,
    plan: { tier: 'Max 20x' },
    quota: { utilization: 34, weeklyUtilization: 52, resetsAt: '2pm', weeklyResetsAt: 'Wed 9am' },
    weeklyCost: [31, 48, 22, 75, 61, 90, 84, 143],
    budget: { limit: 200, spent: 143, level: 75 },
    pinned: [
      { sessionId: S3, title: 'Design the onboarding flow', projectName: 'Acme Storefront', model: 'claude-opus-5', lastActivityAt: now - 3 * HOUR },
    ],
    events: [
      { at: now - 4 * MIN, kind: 'needs you', project: 'Acme Storefront', body: 'Which payment provider should checkout use?' },
      { at: now - 38 * MIN, kind: 'stuck', project: 'Data Pipeline', body: 'Busy with no output for 20 minutes' },
      { at: now - 2 * HOUR, kind: 'budget', project: 'Weekly budget', body: '75% of your $200 budget (≈$143)' },
    ],
    liveSessions: [
      {
        sessionId: S1, pid: 1111, cwd: '/demo/acme-storefront', projectPath: '/demo/acme-storefront',
        projectName: 'Acme Storefront', isWorktree: false, model: 'claude-opus-5',
        title: 'Wire Stripe checkout into the cart', status: 'waiting',
        waitingFor: 'Which payment provider should checkout use?',
        startedAt: now - 47 * MIN, statusUpdatedAt: now - 4 * MIN, quietMin: null,
        currentTask: null, tasksSummary: null, subagents: null, resumeCommand: 'claude --resume demo',
      },
      {
        sessionId: S2, pid: 2222, cwd: '/demo/blog-engine', projectPath: '/demo/blog-engine',
        projectName: 'Blog Engine', isWorktree: false, model: 'claude-fable-5',
        title: 'Migrate posts to the new block format', status: 'busy',
        waitingFor: null, startedAt: now - 3 * HOUR - 12 * MIN, statusUpdatedAt: now - MIN, quietMin: null,
        currentTask: { activeForm: 'Converting legacy shortcodes' },
        tasksSummary: { completed: 7, inProgress: 1, pending: 3 },
        subagents: { count: 4, mtok: 2.3 }, resumeCommand: 'claude --resume demo',
      },
    ],
    projects: [
      mk('Acme Storefront', '/demo/acme-storefront', 2 * MIN,
        { isRepo: true, branch: 'feature/checkout', dirty: 4, untracked: 1, ahead: 2, behind: 0 },
        [2, 5, 3, 8, 6, 9, 4, 7, 11, 6, 8, 12, 9, 14], 89.4),
      mk('Blog Engine', '/demo/blog-engine', 1 * MIN,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [0, 3, 1, 4, 2, 6, 3, 5, 2, 7, 4, 6, 8, 5], 31.7),
      mk('Data Pipeline', '/demo/data-pipeline', 5 * HOUR,
        { isRepo: true, branch: 'main', dirty: 2, untracked: 0, ahead: 1, behind: 0 },
        [1, 0, 2, 1, 3, 0, 2, 4, 1, 3, 2, 0, 5, 2], 18.2),
      mk('Dotfiles', '/demo/dotfiles', 3 * DAY,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0, 0, 1], 2.1),
    ],
    errors: [],
  };
}

function demoStats() {
  const now = Date.now();
  const days = [];
  const costDays = [];
  for (let i = 181; i >= 0; i--) {
    const t = now - i * DAY;
    const c = Math.max(0, Math.round(6 + 6 * Math.sin(i / 3) + (i % 7 === 0 ? -6 : 0)));
    days.push({ t, c });
  }
  for (let i = 89; i >= 0; i--) {
    const t = now - i * DAY;
    const cost = Math.max(0, Math.round((12 + 10 * Math.sin(i / 4)) * 100) / 100);
    costDays.push({ t, cost, tokens: Math.round(cost * 800000) });
  }
  const hours = [0, 0, 0, 0, 0, 0, 1, 3, 8, 14, 18, 22, 19, 16, 20, 17, 12, 9, 6, 4, 3, 2, 1, 0];
  const heat = Array.from({ length: 7 }, (_, d) =>
    hours.map((h) => Math.max(0, Math.round(h * (d === 0 || d === 6 ? 0.3 : 1) * (0.7 + (d % 3) * 0.2)))));
  return {
    days,
    hours,
    heat,
    costDays,
    timeline: [
      { project: 'Acme Storefront', sessionId: S1, title: 'Wire Stripe checkout into the cart', start: now - 47 * MIN, end: now },
      { project: 'Blog Engine', sessionId: S2, title: 'Migrate posts to the new block format', start: now - 3 * HOUR, end: now },
      { project: 'Data Pipeline', sessionId: S3, title: 'Backfill the analytics warehouse', start: now - 9 * HOUR, end: now - 5 * HOUR },
    ],
    week: {
      sessions: 18, prompts: 84, cost: 143.2,
      projects: [
        { name: 'Acme Storefront', cost: 89.4 },
        { name: 'Blog Engine', cost: 31.7 },
        { name: 'Data Pipeline', cost: 18.2 },
      ],
      models: ['claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5'],
      busiestDay: 'Tuesday', busiestHour: 11,
      waits: [22, 31, 18, 4], typicalWait: 'under 2m',
    },
    byModel: {
      'claude-opus-5': { tokens: 310e6, cost: 412.5 },
      'claude-fable-5': { tokens: 120e6, cost: 388.1 },
      'claude-haiku-4-5': { tokens: 42e6, cost: 9.8 },
    },
    perProject: [
      { name: 'Acme Storefront', total: 501.3, models: { 'claude-opus-5': 402.2, 'claude-fable-5': 99.1 } },
      { name: 'Blog Engine', total: 214.6, models: { 'claude-fable-5': 214.6 } },
    ],
    totals: { sessions: 212, prompts: 1841, cost: 810.4 },
  };
}

function demoSession() {
  const now = Date.now();
  return {
    sessionId: S1,
    title: 'Wire Stripe checkout into the cart',
    projectName: 'Acme Storefront',
    truncatedTurns: 0,
    nextOffset: 0,
    events: [
      { kind: 'user', ts: now - 47 * MIN, text: 'Add Stripe checkout to the cart page. Keep the guest flow working.' },
      { kind: 'assistant', ts: now - 46 * MIN, text: "I'll start with the payment intent endpoint, then wire the cart button to it." },
      { kind: 'tool', ts: now - 45 * MIN, name: 'Read', input: 'src/cart/CartPage.tsx' },
      { kind: 'tool', ts: now - 44 * MIN, name: 'Edit', input: 'src/api/checkout.ts' },
      { kind: 'assistant', ts: now - 40 * MIN, text: 'Endpoint is in with tests. The cart button now creates a payment intent and redirects.' },
      { kind: 'user', ts: now - 12 * MIN, text: 'Nice. What about Apple Pay?' },
      { kind: 'assistant', ts: now - 5 * MIN, text: 'Two options: Stripe Payment Request Button (fastest) or a native integration. Which payment provider should checkout use for the wallet flow?' },
    ],
  };
}

module.exports = { demoState, demoStats, demoSession };
