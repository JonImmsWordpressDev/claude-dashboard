# Idle Session Nag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session has been waiting on the user longer than a configurable threshold (default 60 minutes), send one notification, log a catch-up entry, and show the wait time in amber on the departures row.

**Architecture:** The collector already detects the busy→waiting transition; it now remembers *when* each session entered `waiting`. A pure `overdueWaits` helper in `lib/notify.js` picks the sessions past the threshold that haven't been nagged yet. Config gains `idleNagMinutes`; state gains `waitingMin` per live session.

**Tech Stack:** Node ≥ 18, zero dependencies, `node:test`, vanilla JS in `public/index.html`, bash/python for the SwiftBar plugin.

**Spec:** `docs/superpowers/specs/2026-09-15-idle-session-nag-design.md`

## Global Constraints

- Never write to anything under `~/.claude`.
- Zero npm dependencies.
- One nag per wait: the flag resets only when the session leaves `waiting`. Never fire on the first poll after startup for waits that began before the server did (the wait start is only known from the moment the collector sees the transition; a session already waiting at startup starts its clock at startup).
- `waitingMin` is whole minutes and `null` below the threshold, so the state fingerprint stays stable.
- Depends on the waiting-reason plan (`reasonText`, `collector.reasonFor`) for the notification body. If that plan has not run, use the literal `'Claude is waiting for your input'` where `reasonText(this.reasonFor(s))` appears.
- Work on branch `feature-batch-2026-09`. Run `npm test` before every commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Change |
|---|---|
| `lib/config.js` | `idleNagMinutes: 60` default; accepted by `updateConfig`. |
| `lib/notify.js` | `overdueWaits` (pure). |
| `lib/collector.js` | `waitingSince` / `idleNotified` tracking, nag notification, `waitingMin` in state. |
| `public/index.html` | Settings input; amber `waiting 1h 12m` in the departures elapsed cell and Mission Control header. |
| `menubar/claude-dash.15s.sh` | `⏳` marker for overdue waits. |
| `lib/demo.js` | One overdue demo session. |
| `test/pure-logic.test.js` | `overdueWaits`. |
| `README.md` | Bullet + settings line. |

---

### Task 1: Config key

**Files:**
- Modify: `lib/config.js:36` (DEFAULTS), `lib/config.js:65-76` (`updateConfig`)

**Interfaces:**
- Produces: `readConfig().idleNagMinutes: number` (default 60); `updateConfig({ idleNagMinutes })` accepts finite integers ≥ 0.

- [ ] **Step 1: Add the default and validation**

`DEFAULTS` gains `idleNagMinutes: 60`. In `updateConfig`, after the `weeklyBudget` block add:

```js
  if (typeof patch.idleNagMinutes === 'number' && patch.idleNagMinutes >= 0 && Number.isFinite(patch.idleNagMinutes)) {
    next.idleNagMinutes = Math.round(patch.idleNagMinutes);
  }
```

- [ ] **Step 2: Verify quickly**

```bash
node -e "const c=require('./lib/config');console.log(c.readConfig().idleNagMinutes)"
```

Expected: `60` (or whatever `config.json` already says).

- [ ] **Step 3: Commit**

```bash
npm test
git add lib/config.js
git commit -m "Config: idleNagMinutes (default 60, 0 disables)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `overdueWaits` pure helper

**Files:**
- Modify: `lib/notify.js` (after `newlyWaiting`, exports at line 62)
- Test: `test/pure-logic.test.js`

**Interfaces:**
- Produces: `overdueWaits(now, waitingSince: Map<id, ts>, thresholdMs, alreadyNotified: Set<id>) -> id[]` (sorted by wait start, oldest first).

- [ ] **Step 1: Write the failing tests**

```js
const { overdueWaits } = require('../lib/notify');

test('overdueWaits: only waits past the threshold that have not been nagged', () => {
  const now = 10_000_000;
  const since = new Map([['a', now - 61 * 60000], ['b', now - 30 * 60000], ['c', now - 90 * 60000]]);
  assert.deepEqual(overdueWaits(now, since, 60 * 60000, new Set()), ['c', 'a']);
  assert.deepEqual(overdueWaits(now, since, 60 * 60000, new Set(['c'])), ['a']);
});

test('overdueWaits: threshold 0 or less disables the nag', () => {
  const now = 10_000_000;
  const since = new Map([['a', now - 5 * 3600000]]);
  assert.deepEqual(overdueWaits(now, since, 0, new Set()), []);
  assert.deepEqual(overdueWaits(now, since, -1, new Set()), []);
});

test('overdueWaits: exactly at the threshold counts as overdue', () => {
  const now = 10_000_000;
  assert.deepEqual(overdueWaits(now, new Map([['a', now - 60000]]), 60000, new Set()), ['a']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern="overdueWaits" test/pure-logic.test.js` — FAIL, `overdueWaits is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/notify.js` after `newlyWaiting`:

```js
// Sessions waiting longer than thresholdMs that haven't been nagged yet,
// oldest wait first. thresholdMs <= 0 disables the feature.
function overdueWaits(now, waitingSince, thresholdMs, alreadyNotified) {
  if (!(thresholdMs > 0)) return [];
  const out = [];
  for (const [id, since] of waitingSince) {
    if (alreadyNotified.has(id)) continue;
    if (now - since >= thresholdMs) out.push([since, id]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.map(([, id]) => id);
}
```

Export: `module.exports = { sendNotification, newlyWaiting, overdueWaits, isProjectMuted };`

- [ ] **Step 4: Run tests, commit**

```bash
npm test
git add lib/notify.js test/pure-logic.test.js
git commit -m "overdueWaits: pick sessions waiting past the idle threshold

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Collector tracking, notification, and state

**Files:**
- Modify: `lib/collector.js` — imports (line 15), constructor (34–42), `notifyTransitions` (111–127), live entry (284–303)

**Interfaces:**
- Produces: `collector.waitingSince: Map<sessionId, ts>`, `collector.idleNotified: Set<sessionId>`; live entries gain `waitingMin: number|null`.

- [ ] **Step 1: Track wait starts alongside transitions**

Import `overdueWaits`: `const { sendNotification, newlyWaiting, overdueWaits, isProjectMuted } = require('./notify');`

In the constructor add:

```js
    this.waitingSince = new Map(); // sessionId -> when it entered 'waiting'
    this.idleNotified = new Set(); // nagged once for the current wait
```

Replace `notifyTransitions` with:

```js
  notifyTransitions(live) {
    const next = new Map(live.map((s) => [s.sessionId, s.status]));
    const prev = this.prevLiveStatus ?? null;
    const now = Date.now();
    const cfg = readConfig();

    // Wait clocks: start when a session enters 'waiting' (or is already
    // waiting when we first see it), clear when it leaves or ends.
    for (const [id, status] of next) {
      if (status === 'waiting') { if (!this.waitingSince.has(id)) this.waitingSince.set(id, now); }
      else { this.waitingSince.delete(id); this.idleNotified.delete(id); }
    }
    for (const id of [...this.waitingSince.keys()]) {
      if (!next.has(id)) { this.waitingSince.delete(id); this.idleNotified.delete(id); }
    }

    for (const id of newlyWaiting(prev, next)) {
      const s = live.find((x) => x.sessionId === id);
      const root = worktreeRoot(s.cwd).root;
      const body = reasonText(this.reasonFor(s));
      this.logEvent('needs you', friendlyName(root), body);
      if (isProjectMuted(root, cfg.mutedProjects)) continue;
      sendNotification({ title: `${friendlyName(root)} needs you`, body, sound: 'Glass' });
    }

    // Idle nag: one reminder per wait once it passes the threshold.
    const thresholdMs = (cfg.idleNagMinutes || 0) * 60000;
    for (const id of overdueWaits(now, this.waitingSince, thresholdMs, this.idleNotified)) {
      this.idleNotified.add(id);
      const s = live.find((x) => x.sessionId === id);
      if (!s) continue;
      const root = worktreeRoot(s.cwd).root;
      const mins = Math.floor((now - this.waitingSince.get(id)) / 60000);
      const body = `Waiting ${mins} minutes — ${reasonText(this.reasonFor(s))}`;
      this.logEvent('still waiting', friendlyName(root), body);
      if (isProjectMuted(root, cfg.mutedProjects)) continue;
      sendNotification({ title: `${friendlyName(root)} still needs you`, body, sound: 'Glass' });
    }
    this.prevLiveStatus = next;
  }
```

If the waiting-reason plan has not run, replace both `reasonText(this.reasonFor(s))` calls with `s.waitingFor || 'Claude is waiting for your input'`.

- [ ] **Step 2: `waitingMin` in state**

In `assemble()`, before the `liveSessions` map add:

```js
    const nagMs = (readConfig().idleNagMinutes || 0) * 60000;
```

and in the live entry add after `quietMin,`:

```js
        waitingMin: (() => {
          const since = s.status === 'waiting' ? this.waitingSince.get(s.sessionId) : null;
          if (!since || !nagMs) return null;
          const w = Date.now() - since;
          return w >= nagMs ? Math.floor(w / 60000) : null;
        })(),
```

- [ ] **Step 3: Verify the timing without waiting an hour**

Temporarily set `"idleNagMinutes": 1` in `config.json` (settings are read fresh each poll), run `node server.js`, leave a Claude session waiting for a minute: one notification titled "… still needs you", a `still waiting` entry in the catch-up bell, and `waitingMin: 1` in `/api/state` for that session. Answer the session: `waitingMin` returns to `null`. Restore the config value afterwards.

- [ ] **Step 4: Run tests, commit**

```bash
npm test
git add lib/collector.js
git commit -m "Nag once when a session has waited past the idle threshold

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: UI, menu bar, demo

**Files:**
- Modify: `public/index.html` — `liveCard` (968), `mcPaneHead` (1609), settings General block (after the Weekly budget row, ~1905) and handlers (~1985); CSS after `.dep-elapsed` (line 287)
- Modify: `menubar/claude-dash.15s.sh:25-57`
- Modify: `lib/demo.js` live entries

- [ ] **Step 1: CSS**

```css
  .dep-elapsed.overdue { color: var(--warn); font-weight: 600; }
```

- [ ] **Step 2: Departures and Mission Control**

Add a helper after `elapsed()`:

```js
function waitLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `waiting ${h ? `${h}h ${m}m` : `${m}m`}`;
}
```

In `liveCard`, replace `<span class="dep-elapsed">${elapsed(s.startedAt)}</span>` with:

```js
      ${s.waitingMin != null
        ? `<span class="dep-elapsed overdue" title="No reply for ${s.waitingMin} minutes — session started ${elapsed(s.startedAt)} ago">${waitLabel(s.waitingMin)}</span>`
        : `<span class="dep-elapsed">${elapsed(s.startedAt)}</span>`}
```

In `mcPaneHead`, replace `<span class="mc-meta">${elapsed(s.startedAt)}</span>` with:

```js
    <span class="mc-meta${s.waitingMin != null ? ' overdue' : ''}"${s.waitingMin != null ? ' style="color:var(--warn)"' : ''}>${s.waitingMin != null ? waitLabel(s.waitingMin) : elapsed(s.startedAt)}</span>
```

- [ ] **Step 3: Settings**

After the Weekly budget row in `openSettings` add:

```html
      <div class="set-row">
        <span class="set-label">Idle reminder<span class="set-sub">minutes a session can sit on "needs you" before one reminder fires; 0 turns it off</span></span>
        <input type="text" id="set-idle" inputmode="numeric" style="width:70px;text-align:right" value="${c.idleNagMinutes ?? 60}" placeholder="60">
      </div>
```

Handler beside the budget one:

```js
    $('#set-idle').addEventListener('change', (e) => {
      const n = Math.max(0, Math.round(Number(e.target.value) || 0));
      e.target.value = n;
      saveSetting('/api/config', { idleNagMinutes: n }, n ? `Idle reminder after ${n} min` : 'Idle reminder off');
    });
```

Add `idleNagMinutes: 60,` to the demo `/api/config` response in `server.js`.

- [ ] **Step 4: Menu bar**

In `menubar/claude-dash.15s.sh`, after `quiet = [...]` add `overdue = [l for l in live if l.get("waitingMin") is not None]`, change the waiting title line to:

```python
if waiting:
    print(f"❯ {len(waiting)}⚠{'⏳' if overdue else ''} | color=#e0a63a")
```

and in the per-session loop, for waiting sessions:

```python
        if l.get("status") == "waiting":
            what = l.get("waitingFor") or (l.get("waitingReason") or {}).get("text") or "waiting"
            wm = l.get("waitingMin")
            tail = f" ({wm//60}h {wm%60}m)" if wm is not None else ""
            print(f"{name} — {what}{tail} | color=#e0a63a")
```

- [ ] **Step 5: Demo**

In `lib/demo.js`, add `waitingMin: null,` to each live entry, then set the Acme Storefront (S1) one to `waitingMin: 74` (and its `statusUpdatedAt` to `now - 74 * MIN`). Add a catch-up event: `{ at: now - 14 * MIN, kind: 'still waiting', project: 'Acme Storefront', body: 'Waiting 60 minutes — Which payment provider should checkout use for the wallet flow?' }`.

- [ ] **Step 6: Check**

Demo mode: the Acme Storefront row's elapsed cell reads `waiting 1h 14m` in amber; Mission Control header the same; the bell lists "still waiting". Settings shows the Idle reminder input; changing it toasts and persists (live mode).

- [ ] **Step 7: Commit**

```bash
git add public/index.html menubar/claude-dash.15s.sh lib/demo.js server.js
git commit -m "Show overdue waits in amber; idle reminder setting; menu bar marker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: README

- [ ] **Step 1:** After the "Stuck flag" bullet (README line 110) add:

```
- **Idle reminder** — a session left on **needs you** for an hour (configurable in settings, `0` to turn off) gets one more notification and a `still waiting` entry in the catch-up bell, and its elapsed cell turns amber with the wait time. Nothing repeats until you answer it.
```

Under Settings add:

```
- **Idle reminder** in minutes — one extra notification when a session has waited that long; `0` turns it off
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: idle reminder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: config key + settings input (Tasks 1, 4); `waitingSince` / `idleNotified` cleared on transition (Task 3); `overdueWaits` pure + tests (Task 2); notification with reason, catch-up kind `still waiting`, mute respected (Task 3); `waitingMin` whole minutes, null below threshold (Task 3); departures + Mission Control amber (Task 4); menu bar `⏳` (Task 4); demo (Task 4); README (Task 5).
- Names used consistently: `idleNagMinutes`, `overdueWaits`, `waitingSince`, `idleNotified`, `waitingMin`, `waitLabel`.
