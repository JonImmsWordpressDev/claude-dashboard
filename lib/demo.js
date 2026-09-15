'use strict';
// CLAUDE_DASH_DEMO=1: serve believable fake data instead of reading ~/.claude.
// For screenshots, demos, and trying the dashboard without any Claude history.
// Times are computed relative to now on every call so the board looks alive.
// Every project here is invented — the README screenshots are generated from
// this file so they never leak a real project name.

const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const S1 = 'demo1111-1111-4111-8111-111111111111';
const S2 = 'demo2222-2222-4222-8222-222222222222';
const S3 = 'demo3333-3333-4333-8333-333333333333';
const S4 = 'demo4444-4444-4444-8444-444444444444';

let seq = 0;
const sid = () => `demo${String(++seq).padStart(4, '0')}-0000-4000-8000-000000000000`;

// One session row as it appears on a project card and in the digest.
function sess(now, o) {
  return {
    sessionId: o.id || sid(),
    estCost: o.cost,
    model: o.model,
    title: o.title,
    titleSource: 'ai',
    lastPrompt: o.prompt || o.title,
    awaySummary: o.summary || null,
    awaySummaryAt: o.summary ? now - o.ago : null,
    tasksSummary: o.tasks || null,
    changeCount: o.changes || 0,
    startedAt: now - o.ago - (o.ran || 40 * MIN),
    lastActivityAt: now - o.ago,
    worktree: o.worktree || null,
    resumeCommand: 'claude --resume demo',
  };
}

function demoState() {
  seq = 0;
  const now = Date.now();
  const mk = (name, path, ago, git, spark, spend, sessions) => ({
    path,
    name,
    lastActivityAt: now - ago,
    isLive: ago < 5 * MIN,
    git,
    spend7d: spend,
    activity: { days: 14, counts: spark },
    sessions,
    stats: { sessionCount: sessions.length, promptCount: sessions.length * 11, lastCost: null },
  });
  return {
    generatedAt: now,
    plan: { tier: 'Max 20x' },
    quota: { utilization: 34, weeklyUtilization: 52, resetsAt: '2pm', weeklyResetsAt: 'Wed 9am' },
    weeklyCost: [31, 48, 22, 75, 61, 90, 84, 143],
    budget: { limit: 200, spent: 143, level: 75 },
    pinned: [
      { sessionId: S3, title: 'Design the onboarding flow', projectName: 'Acme Storefront', model: 'claude-opus-5', lastActivityAt: now - 3 * HOUR, changeCount: 3 },
    ],
    events: [
      { at: now - 4 * MIN, kind: 'needs you', project: 'Acme Storefront', body: 'Which payment provider should checkout use?' },
      { at: now - 14 * MIN, kind: 'still waiting', project: 'Acme Storefront', body: 'Waiting 60 minutes — Which payment provider should checkout use for the wallet flow?' },
      { at: now - 38 * MIN, kind: 'stuck', project: 'Data Pipeline', body: 'Busy with no output for 20 minutes' },
      { at: now - 2 * HOUR, kind: 'budget', project: 'Weekly budget', body: '75% of your $200 budget (≈$143)' },
    ],
    liveSessions: [
      {
        sessionId: S1, pid: 1111, cwd: '/demo/acme-storefront', projectPath: '/demo/acme-storefront',
        projectName: 'Acme Storefront', isWorktree: false, model: 'claude-opus-5',
        title: 'Wire Stripe checkout into the cart', status: 'waiting',
        waitingFor: null,
        waitingReason: { kind: 'question', text: 'Which payment provider should checkout use for the wallet flow?', options: ['Payment Request Button', 'Native per wallet'] },
        startedAt: now - 2 * HOUR - 10 * MIN, statusUpdatedAt: now - 74 * MIN, quietMin: null, waitingMin: 74,
        currentTask: null, tasksSummary: null, subagents: null, resumeCommand: 'claude --resume demo',
        agents: null,
      },
      {
        sessionId: S2, pid: 2222, cwd: '/demo/blog-engine', projectPath: '/demo/blog-engine',
        projectName: 'Blog Engine', isWorktree: false, model: 'claude-fable-5',
        title: 'Migrate posts to the new block format', status: 'busy',
        waitingFor: null, waitingReason: null, startedAt: now - 3 * HOUR - 12 * MIN, statusUpdatedAt: now - MIN, quietMin: null, waitingMin: null,
        currentTask: { activeForm: 'Converting legacy shortcodes' },
        tasksSummary: { completed: 7, inProgress: 1, pending: 3 },
        subagents: { count: 4, mtok: 2.3 }, resumeCommand: 'claude --resume demo',
        agents: { team: 'block-migration', list: [
          { name: 'inventory', type: 'explore', model: 'claude-haiku-4-5', color: 'cyan', status: 'done' },
          { name: 'converter', type: 'general-purpose', model: 'claude-fable-5', color: 'blue', status: 'active' },
          { name: 'reviewer', type: 'code-review', model: 'claude-opus-5', color: 'purple', status: 'active' },
        ] },
      },
      {
        sessionId: S4, pid: 4444, cwd: '/demo/data-pipeline', projectPath: '/demo/data-pipeline',
        projectName: 'Data Pipeline', isWorktree: false, model: 'claude-sonnet-5',
        title: 'Backfill the analytics warehouse', status: 'waiting',
        waitingFor: null,
        waitingReason: { kind: 'permission', text: 'Bash node scripts/backfill.mjs --apply --from 2026-01-01' },
        startedAt: now - 22 * MIN, statusUpdatedAt: now - 2 * MIN, quietMin: null, waitingMin: null,
        currentTask: { activeForm: 'Applying the backfill' }, tasksSummary: { completed: 4, inProgress: 1, pending: 4 },
        subagents: null, resumeCommand: 'claude --resume demo',
        agents: null,
      },
    ],
    projects: [
      mk('Acme Storefront', '/demo/acme-storefront', 2 * MIN,
        { isRepo: true, branch: 'feature/checkout', dirty: 4, untracked: 1, ahead: 2, behind: 0 },
        [2, 5, 3, 8, 6, 9, 4, 7, 11, 6, 8, 12, 9, 14], 89.4, [
          sess(now, { id: S1, ago: 2 * MIN, cost: 24.6, model: 'claude-opus-5', title: 'Wire Stripe checkout into the cart',
            tasks: { completed: 5, inProgress: 1, pending: 2 }, changes: 3 }),
          sess(now, { id: S3, ago: 3 * HOUR, cost: 18.2, model: 'claude-opus-5', title: 'Design the onboarding flow',
            summary: 'Onboarding is three screens: account, store details, first product. Copy is still placeholder.',
            tasks: { completed: 9, inProgress: 0, pending: 1 }, changes: 3 }),
          sess(now, { ago: 30 * HOUR, cost: 11.05, model: 'claude-fable-5', title: 'Cart totals rounding bug' }),
          sess(now, { ago: 26 * HOUR, cost: 31.4, model: 'claude-opus-5', title: 'Split the product page into blocks' }),
          sess(now, { ago: 3 * DAY, cost: 4.12, model: 'claude-haiku-4-5', title: 'Bump dependencies and re-run the suite' }),
        ]),
      mk('Blog Engine', '/demo/blog-engine', 1 * MIN,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [0, 3, 1, 4, 2, 6, 3, 5, 2, 7, 4, 6, 8, 5], 31.7, [
          sess(now, { id: S2, ago: 1 * MIN, cost: 12.85, model: 'claude-fable-5', title: 'Migrate posts to the new block format',
            tasks: { completed: 7, inProgress: 1, pending: 3 }, changes: 3 }),
          sess(now, { ago: 28 * HOUR, cost: 6.4, model: 'claude-fable-5', title: 'Add reading time to post templates',
            summary: 'Reading time ships as a template part, cached with the post. Tests cover the empty-post case.' }),
          sess(now, { ago: 2 * DAY, cost: 8.9, model: 'claude-sonnet-5', title: 'Fix the RSS feed date format', worktree: 'rss-fix' }),
          sess(now, { ago: 4 * DAY, cost: 3.55, model: 'claude-haiku-4-5', title: 'Tidy the editor stylesheet' }),
        ]),
      mk('Claude Dashboard', '/demo/claude-dashboard', 38 * MIN,
        { isRepo: true, branch: 'main', dirty: 1, untracked: 0, ahead: 3, behind: 0 },
        [1, 4, 2, 6, 5, 3, 7, 9, 4, 8, 6, 10, 7, 9], 42.6, [
          sess(now, { ago: 38 * MIN, cost: 14.2, model: 'claude-opus-5', title: 'Refresh the README screenshots',
            summary: 'Screenshots now come from demo mode, so no real project names reach the repo.',
            tasks: { completed: 6, inProgress: 0, pending: 0 }, changes: 3 }),
          sess(now, { ago: 6 * HOUR, cost: 9.8, model: 'claude-fable-5', title: 'Incremental transcript scanning' }),
          sess(now, { ago: 2 * DAY, cost: 18.6, model: 'claude-opus-5', title: 'Add the command palette' }),
        ]),
      mk('Data Pipeline', '/demo/data-pipeline', 2 * MIN,
        { isRepo: true, branch: 'main', dirty: 2, untracked: 0, ahead: 1, behind: 0 },
        [1, 0, 2, 1, 3, 0, 2, 4, 1, 3, 2, 0, 5, 2], 18.2, [
          sess(now, { id: S4, ago: 2 * MIN, cost: 9.15, model: 'claude-sonnet-5', title: 'Backfill the analytics warehouse',
            tasks: { completed: 4, inProgress: 1, pending: 4 } }),
          sess(now, { ago: 30 * HOUR, cost: 5.7, model: 'claude-sonnet-5', title: 'Retry logic for the nightly job' }),
          sess(now, { ago: 5 * DAY, cost: 3.35, model: 'claude-haiku-4-5', title: 'Document the ingest schema' }),
        ]),
      mk('Design System', '/demo/design-system', 27 * HOUR,
        { isRepo: true, branch: 'tokens', dirty: 0, untracked: 3, ahead: 0, behind: 1 },
        [3, 2, 4, 1, 5, 2, 3, 6, 2, 4, 3, 5, 1, 4], 26.9, [
          sess(now, { ago: 27 * HOUR, cost: 16.4, model: 'claude-opus-5', title: 'Colour tokens for dark mode' }),
          sess(now, { ago: 4 * DAY, cost: 10.5, model: 'claude-fable-5', title: 'Rewrite the button component docs' }),
        ]),
      mk('Internal Tools', '/demo/internal-tools', 2 * DAY,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [0, 1, 0, 2, 1, 0, 3, 1, 0, 2, 1, 1, 0, 2], 12.4, [
          sess(now, { ago: 2 * DAY, cost: 7.2, model: 'claude-sonnet-5', title: 'Rota export as CSV' }),
          sess(now, { ago: 6 * DAY, cost: 5.2, model: 'claude-haiku-4-5', title: 'Fix the login redirect loop' }),
        ]),
      mk('Marketing Site', '/demo/marketing-site', 4 * DAY,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [2, 0, 1, 0, 3, 1, 0, 0, 2, 1, 0, 1, 0, 0], 9.6, [
          sess(now, { ago: 4 * DAY, cost: 6.1, model: 'claude-fable-5', title: 'Rebuild the pricing page' }),
          sess(now, { ago: 8 * DAY, cost: 3.5, model: 'claude-haiku-4-5', title: 'Compress the hero images' }),
        ]),
      mk('Dotfiles', '/demo/dotfiles', 3 * DAY,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0, 0, 1], 2.1, [
          sess(now, { ago: 3 * DAY, cost: 2.1, model: 'claude-haiku-4-5', title: 'Move shell aliases into a module' }),
        ]),
      mk('Legacy Importer', '/demo/legacy-importer', 96 * DAY,
        { isRepo: true, branch: 'main', dirty: 0, untracked: 0, ahead: 0, behind: 0 },
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0, [
          sess(now, { ago: 96 * DAY, cost: 4.4, model: 'claude-sonnet-5', title: 'One-off CSV import for the old CRM' }),
        ]),
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
        { name: 'Claude Dashboard', cost: 42.6 },
        { name: 'Blog Engine', cost: 31.7 },
        { name: 'Design System', cost: 26.9 },
        { name: 'Data Pipeline', cost: 18.2 },
      ],
      models: ['claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5'],
      busiestDay: 'Tuesday', busiestHour: 11,
      waits: [22, 31, 18, 4], typicalWait: 'under 2m',
    },
    byModel: {
      'claude-opus-5': { tokens: 310e6, cost: 412.5 },
      'claude-fable-5': { tokens: 120e6, cost: 388.1 },
      'claude-sonnet-5': { tokens: 88e6, cost: 61.4 },
      'claude-haiku-4-5': { tokens: 42e6, cost: 9.8 },
    },
    perProject: [
      { name: 'Acme Storefront', total: 501.3, models: { 'claude-opus-5': 402.2, 'claude-fable-5': 99.1 } },
      { name: 'Blog Engine', total: 214.6, models: { 'claude-fable-5': 214.6 } },
      { name: 'Claude Dashboard', total: 142.9, models: { 'claude-opus-5': 96.4, 'claude-fable-5': 46.5 } },
      { name: 'Design System', total: 88.1, models: { 'claude-opus-5': 61.2, 'claude-haiku-4-5': 26.9 } },
    ],
    totals: { sessions: 212, prompts: 1841, cost: 810.4 },
  };
}

// `after` mirrors the live-follow poll: once the viewer has the canned
// transcript there is nothing new, so return an empty tail instead of
// re-sending every event.
function demoSession(id, after) {
  const now = Date.now();
  if (id === S2) return blogSession(now, after);
  if (id === S4) return pipelineSession(now, after);
  return {
    sessionId: S1,
    title: 'Wire Stripe checkout into the cart',
    projectName: 'Acme Storefront',
    changeCount: 3,
    truncatedTurns: 0,
    nextOffset: 1,
    events: after ? [] : [
      { kind: 'user', ts: now - 47 * MIN, text: 'Add Stripe checkout to the cart page. Keep the guest flow working.' },
      { kind: 'assistant', ts: now - 46 * MIN, text: "I'll start with the payment intent endpoint, then wire the cart button to it.\n\nPlan:\n\n1. `POST /api/checkout` creating the intent server-side\n2. Cart button calls it and redirects to the hosted page\n3. Webhook marks the order paid\n\nGuest carts already carry a session id, so nothing changes for signed-out users." },
      { kind: 'tool', ts: now - 45 * MIN, name: 'Read', input: 'src/cart/CartPage.tsx' },
      { kind: 'tool', ts: now - 45 * MIN, name: 'Grep', input: 'createPaymentIntent' },
      { kind: 'tool', ts: now - 44 * MIN, name: 'Edit', input: 'src/api/checkout.ts' },
      { kind: 'tool', ts: now - 43 * MIN, name: 'Bash', input: 'npm test -- checkout' },
      { kind: 'assistant', ts: now - 40 * MIN, text: 'Endpoint is in with tests. The cart button now creates a payment intent and redirects.\n\n```ts\nexport async function createCheckout(cart: Cart) {\n  const intent = await stripe.paymentIntents.create({\n    amount: totalInMinorUnits(cart),\n    currency: cart.currency,\n    metadata: { cartId: cart.id },\n  });\n  return intent.client_secret;\n}\n```\n\nAll 14 checkout tests pass.' },
      { kind: 'note', ts: now - 39 * MIN, text: 'Checkout endpoint merged with tests. Guest flow untouched. Next: the wallet buttons.' },
      { kind: 'user', ts: now - 12 * MIN, text: 'Nice. What about Apple Pay?' },
      { kind: 'tool', ts: now - 11 * MIN, name: 'Read', input: 'src/cart/PaymentButtons.tsx' },
      { kind: 'assistant', ts: now - 5 * MIN, text: 'Two options: Stripe Payment Request Button (fastest — one component, handles Apple Pay and Google Pay together) or a native integration per wallet.\n\nThe Payment Request Button reuses the intent we already create, so it is roughly an afternoon. Native gets you more control over the sheet and costs a week.\n\nWhich payment provider should checkout use for the wallet flow?' },
    ],
  };
}

function blogSession(now, after) {
  return {
    sessionId: S2,
    title: 'Migrate posts to the new block format',
    projectName: 'Blog Engine',
    changeCount: 3,
    truncatedTurns: 0,
    nextOffset: 1,
    agents: { team: 'block-migration', list: [
      { name: 'inventory', type: 'explore', model: 'claude-haiku-4-5', color: 'cyan', status: 'done' },
      { name: 'converter', type: 'general-purpose', model: 'claude-fable-5', color: 'blue', status: 'done' },
      { name: 'reviewer', type: 'code-review', model: 'claude-opus-5', color: 'purple', status: 'done' },
    ] },
    events: after ? [] : [
      { kind: 'user', ts: now - 3 * HOUR, text: 'Convert the legacy shortcodes in old posts to real blocks. Do it post by post so we can stop halfway.' },
      { kind: 'assistant', ts: now - 3 * HOUR + 2 * MIN, text: 'Starting with an inventory of which shortcodes actually appear, then a converter per shortcode. Nothing is written until a post round-trips cleanly.' },
      { kind: 'tool', ts: now - 2 * HOUR - 50 * MIN, name: 'Grep', input: '\\[[a-z_]+' },
      { kind: 'tool', ts: now - 2 * HOUR - 44 * MIN, name: 'Write', input: 'scripts/convert-shortcodes.mjs' },
      { kind: 'assistant', ts: now - 2 * HOUR - 10 * MIN, text: 'Six shortcodes cover 94% of posts: `gallery`, `caption`, `pullquote`, `embed`, `code`, `columns`. The long tail is 11 posts I will flag rather than guess at.' },
      { kind: 'tool', ts: now - 90 * MIN, name: 'Bash', input: 'node scripts/convert-shortcodes.mjs --dry-run' },
      { kind: 'assistant', ts: now - 80 * MIN, text: 'Dry run over 412 posts: 401 convert cleanly, 11 need a look. Writing the converted content now, one post per transaction.' },
      { kind: 'note', ts: now - 40 * MIN, text: 'Converter written and dry-run clean. Applying to posts in batches of 25.' },
      { kind: 'tool', ts: now - 4 * MIN, name: 'Bash', input: 'node scripts/convert-shortcodes.mjs --apply --batch 25' },
    ],
  };
}

function pipelineSession(now, after) {
  return {
    sessionId: S4,
    title: 'Backfill the analytics warehouse',
    projectName: 'Data Pipeline',
    truncatedTurns: 0,
    nextOffset: 1,
    events: after ? [] : [
      { kind: 'user', ts: now - 22 * MIN, text: 'Backfill the warehouse from January. Dry-run first, then apply.' },
      { kind: 'tool', ts: now - 20 * MIN, name: 'Bash', input: 'node scripts/backfill.mjs --dry-run --from 2026-01-01' },
      { kind: 'assistant', ts: now - 6 * MIN, text: 'Dry run is clean: 1.2M rows, no schema drift. Applying now — this writes to the warehouse, so it needs your approval.' },
      { kind: 'tool', ts: now - 2 * MIN, name: 'Bash', input: 'node scripts/backfill.mjs --apply --from 2026-01-01' },
    ],
  };
}

// Canned change list + diffs for the transcript viewer's changes panel.
function demoChanges(id, file) {
  const now = Date.now();
  const files = [
    { n: 0, path: '/demo/acme-storefront/src/api/checkout.ts', rel: 'src/api/checkout.ts', versions: [1, 2], first: now - 44 * MIN, last: now - 40 * MIN, exists: true, missingBackup: false, added: 7, removed: 2, tooLarge: false },
    { n: 1, path: '/demo/acme-storefront/src/cart/CartPage.tsx', rel: 'src/cart/CartPage.tsx', versions: [1], first: now - 42 * MIN, last: now - 42 * MIN, exists: true, missingBackup: false, added: 4, removed: 1, tooLarge: false },
    { n: 2, path: '/demo/acme-storefront/src/cart/legacy-checkout.ts', rel: 'src/cart/legacy-checkout.ts', versions: [1], first: now - 41 * MIN, last: now - 41 * MIN, exists: false, missingBackup: false, added: 0, removed: 4, tooLarge: false },
  ];
  if (file === null || file === undefined) return { sessionId: id, files };
  const n = Number(file) || 0;
  const f = files[n] || files[0];
  return {
    sessionId: id, path: f.path, rel: f.rel, from: 1, to: 'disk', added: f.added, removed: f.removed, truncated: false, tooLarge: false,
    hunks: f.n === 0
      ? [{ aStart: 1, aLines: 5, bStart: 1, bLines: 10, lines: [
          [' ', "import { stripe } from '../lib/stripe';"],
          [' ', ''],
          ['-', 'export async function createCheckout(cart) {'],
          ['-', "  throw new Error('not implemented');"],
          ['+', 'export async function createCheckout(cart: Cart) {'],
          ['+', '  const intent = await stripe.paymentIntents.create({'],
          ['+', '    amount: totalInMinorUnits(cart),'],
          ['+', '    currency: cart.currency,'],
          ['+', '    metadata: { cartId: cart.id },'],
          ['+', '  });'],
          ['+', '  return intent.client_secret;'],
          [' ', '}'],
        ] }]
      : f.n === 1
        ? [{ aStart: 12, aLines: 4, bStart: 12, bLines: 7, lines: [
            [' ', '  const total = useCartTotal(cart);'],
            [' ', '  return ('],
            ['-', '    <button onClick={() => legacyCheckout(cart)}>Checkout</button>'],
            ['+', '    <button onClick={async () => {'],
            ['+', '      const secret = await createCheckout(cart);'],
            ['+', '      redirectToHostedPage(secret);'],
            ['+', '    }}>Checkout</button>'],
            [' ', '  );'],
          ] }]
        : [{ aStart: 1, aLines: 4, bStart: 1, bLines: 0, lines: [['-', 'export function legacyCheckout(cart) {'], ['-', '  // replaced by src/api/checkout.ts'], ['-', '  return redirect("/checkout/legacy");'], ['-', '}']] }],
  };
}

function demoInventory() {
  const now = Date.now();
  return {
    plugins: [
      { id: 'superpowers@claude-plugins-official', name: 'superpowers', marketplace: 'claude-plugins-official', version: '6.3.0', installedAt: now - 40 * DAY, lastUpdated: now - 2 * DAY, enabled: true, installed: true, stale: false },
      { id: 'playwright@claude-plugins-official', name: 'playwright', marketplace: 'claude-plugins-official', version: 'f0dce59fec06', installedAt: now - 90 * DAY, lastUpdated: now - 20 * DAY, enabled: true, installed: true, stale: true },
      { id: 'frontend-design@claude-plugins-official', name: 'frontend-design', marketplace: 'claude-plugins-official', version: 'f0dce59fec06', installedAt: now - 60 * DAY, lastUpdated: now - 2 * DAY, enabled: true, installed: true, stale: false },
      { id: 'figma@claude-plugins-official', name: 'figma', marketplace: 'claude-plugins-official', version: '2.2.111', installedAt: now - 30 * DAY, lastUpdated: now - 2 * DAY, enabled: false, installed: true, stale: false },
      { id: 'code-review@claude-code-plugins', name: 'code-review', marketplace: 'claude-code-plugins', version: null, installedAt: null, lastUpdated: null, enabled: false, installed: false, stale: false },
    ],
    marketplaces: [
      { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official', lastUpdated: now - 2 * DAY },
      { name: 'claude-code-plugins', repo: 'anthropics/claude-code', lastUpdated: now - 2 * DAY },
    ],
    mcp: [
      { name: 'playwright', scope: 'mcp.json', projects: ['/demo/acme-storefront'], disabledIn: [], active: true, type: 'stdio', command: 'npx', args: 1, url: null, needsAuth: false },
      { name: 'ruflo', scope: 'project', projects: ['/demo/acme-storefront', '/demo/blog-engine'], disabledIn: [], active: true, type: 'stdio', command: 'ruflo', args: 0, url: null, needsAuth: false },
      { name: 'claude.ai Sentry', scope: 'claude.ai', projects: [], disabledIn: [], active: true, type: 'remote', command: null, args: 0, url: null, needsAuth: true },
    ],
    summary: { plugins: 4, enabled: 3, servers: 3, disabled: 0, needAuth: 1 },
  };
}

module.exports = { demoState, demoStats, demoSession, demoChanges, demoInventory };

