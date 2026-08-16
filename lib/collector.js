'use strict';
// Merges every source into one in-memory state object and notifies on change.
const fs = require('fs');
const { readLiveSessions } = require('./sessions');
const { readTasks } = require('./tasks');
const { readQuota } = require('./quota');
const { fetchOauthUsage } = require('./usage');
const { readRegistry } = require('./registry');
const { refreshHistory, activityBuckets, weekHourHeat } = require('./history');
const { scanAllTranscripts, groupByProject, sessionTitle, combinedUsage, combinedDays, dailyCostSeries, subagentSummary, dayKey } = require('./transcripts');
const { collectGitStatus } = require('./gitstatus');
const { friendlyName } = require('./names');
const { isIgnored } = require('./ignore');
const { worktreeRoot } = require('./paths');
const { sendNotification, newlyWaiting, isProjectMuted } = require('./notify');
const { readConfig } = require('./config');
const { estimateCost, budgetLevel, typicalWait } = require('./pricing');
const { readPlan } = require('./plan');

// A busy session whose transcript hasn't grown for this long may be stalled.
const QUIET_FLAG_MS = 10 * 60 * 1000;
const QUIET_NOTIFY_MS = 20 * 60 * 1000;
const SPEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MISSING_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSIONS_PER_PROJECT = 5;

const CADENCE = {
  active: { live: 2_000, scan: 15_000, git: 30_000, quota: 60_000 },
  idle: { live: 15_000, scan: 60_000, git: 300_000, quota: 300_000 },
};

class Collector {
  constructor() {
    this.state = { generatedAt: 0, quota: null, liveSessions: [], projects: [], errors: [] };
    this.raw = { live: [], transcriptGroups: new Map(), history: new Map(), git: new Map(), quota: null };
    this.listeners = new Set();
    this.clientCount = 0;
    this.timers = [];
    this.fingerprint = '';
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setClientCount(n) {
    const wasIdle = this.clientCount === 0;
    this.clientCount = n;
    if (wasIdle && n > 0) this.kick(); // wake from idle cadence immediately
  }

  cadence() {
    return this.clientCount > 0 ? CADENCE.active : CADENCE.idle;
  }

  async start() {
    await Promise.all([this.refreshLive(), this.refreshQuota(), this.refreshScan()]);
    await this.refreshGit(); // needs project list from scan
    this.assemble();
    this.loop('live', () => this.refreshLive());
    this.loop('scan', () => this.refreshScan());
    this.loop('git', () => this.refreshGit());
    this.loop('quota', () => this.refreshQuota());
  }

  loop(name, fn) {
    const tick = async () => {
      try {
        await fn();
        this.assemble();
      } catch (e) {
        this.noteError(name, e);
      }
      const t = setTimeout(tick, this.cadence()[name]);
      t.unref();
      this.timers.push(t);
    };
    const t = setTimeout(tick, this.cadence()[name]);
    t.unref();
    this.timers.push(t);
  }

  kick() {
    // On first client connect, refresh the fast-moving data right away.
    Promise.all([this.refreshLive(), this.refreshQuota()])
      .then(() => this.assemble())
      .catch(() => {});
  }

  async refreshLive() {
    const live = await readLiveSessions();
    for (const s of live) {
      const t = await readTasks(s.sessionId);
      s.currentTask = t ? t.currentTask : null;
      s.tasksSummary = t ? t.tasksSummary : null;
    }
    this.raw.live = live;
    this.notifyTransitions(live);
  }

  notifyTransitions(live) {
    const next = new Map(live.map((s) => [s.sessionId, s.status]));
    const prev = this.prevLiveStatus ?? null;
    for (const id of newlyWaiting(prev, next)) {
      const s = live.find((x) => x.sessionId === id);
      const root = worktreeRoot(s.cwd).root;
      if (isProjectMuted(root, readConfig().mutedProjects)) continue;
      const project = friendlyName(root);
      sendNotification({
        title: `${project} needs you`,
        body: s.waitingFor || 'Claude is waiting for your input',
        sound: 'Glass',
      });
    }
    this.prevLiveStatus = next;
  }

  async refreshScan() {
    const sessions = await scanAllTranscripts();
    this.raw.transcriptGroups = groupByProject(sessions);
    this.raw.history = await refreshHistory();
    // Task summaries for recent sessions (readTasks caches by dir mtime).
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) {
        if (m.lastActivityAt >= cutoff) {
          const t = await readTasks(m.sessionId);
          m.tasksSummary = t ? t.tasksSummary : null;
        }
      }
    }
  }

  async refreshGit() {
    const paths = this.projectPaths().filter((p) => existsDir(p));
    this.raw.git = await collectGitStatus(paths);
  }

  async refreshQuota() {
    // Live OAuth usage first (Keychain-authed, macOS); statusline cache as
    // the fallback for other platforms or when the toggle is off.
    this.raw.quota = (await fetchOauthUsage()) || (await readQuota());
  }

  projectPaths() {
    const set = new Map(); // lowercase -> display path
    for (const [key, g] of this.raw.transcriptGroups) set.set(key, g.path);
    for (const [key, e] of readRegistry()) if (!set.has(key)) set.set(key, e.path);
    for (const [key, e] of this.raw.history) if (!set.has(key)) set.set(key, e.path);
    for (const s of this.raw.live) {
      const { root } = worktreeRoot(s.cwd);
      if (!set.has(root.toLowerCase())) set.set(root.toLowerCase(), root);
    }
    return [...set.values()].filter((p) => !isIgnored(p));
  }

  assemble() {
    const registry = readRegistry();
    const liveByProject = new Set(
      this.raw.live.map((s) => worktreeRoot(s.cwd).root.toLowerCase())
    );

    const projects = [];
    for (const p of this.projectPaths()) {
      const key = p.toLowerCase();
      const group = this.raw.transcriptGroups.get(key);
      const hist = this.raw.history.get(key);
      const reg = registry.get(key);
      const git = this.raw.git.get(p) || null;

      const sessionMetas = group ? group.sessions : [];
      const lastActivityAt = Math.max(
        sessionMetas[0] ? sessionMetas[0].lastActivityAt : 0,
        hist ? hist.lastTimestamp : 0,
        reg ? reg.lastSessionModified || 0 : 0
      );

      const missing = !existsDir(p);
      if (missing && (!lastActivityAt || Date.now() - lastActivityAt > MISSING_GRACE_MS)) continue;
      if (!sessionMetas.length && !hist && !lastActivityAt) continue;

      projects.push({
        path: p,
        name: friendlyName(p),
        missing,
        lastActivityAt: lastActivityAt || null,
        isLive: liveByProject.has(key),
        git,
        spend7d: sessionMetas.reduce(
          (sum, m) =>
            Date.now() - m.lastActivityAt < SPEND_WINDOW_MS ? sum + estimateCost(combinedUsage(m)) : sum,
          0
        ),
        sessions: sessionMetas.slice(0, SESSIONS_PER_PROJECT).map((m) => {
          const { title, source } = sessionTitle(m);
          return {
            sessionId: m.sessionId,
            estCost: estimateCost(combinedUsage(m)),
            model: m.model,
            title,
            titleSource: source,
            lastPrompt: m.lastPrompt,
            awaySummary: m.awaySummary,
            awaySummaryAt: m.awaySummaryAt || null,
            tasksSummary: m.tasksSummary || null,
            startedAt: m.startedAt,
            lastActivityAt: m.lastActivityAt,
            worktree: m.worktree,
            resumeCommand: resumeCommand(m.cwd, m.sessionId),
          };
        }),
        activity: { days: 14, counts: activityBuckets(hist ? hist.timestamps : []) },
        stats: {
          sessionCount: sessionMetas.length,
          promptCount: hist ? hist.promptCount : 0,
          lastCost: reg && typeof reg.lastCost === 'number' ? reg.lastCost : null,
        },
      });
    }
    projects.sort((a, b) => Number(b.isLive) - Number(a.isLive) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

    const titleBySession = new Map();
    const modelBySession = new Map();
    const subsBySession = new Map();
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) {
        titleBySession.set(m.sessionId, sessionTitle(m).title);
        if (m.model) modelBySession.set(m.sessionId, m.model);
        const subs = subagentSummary(m);
        if (subs) subsBySession.set(m.sessionId, subs);
      }
    }

    // Transcript freshness per session, for stuck detection.
    const activityBySession = new Map();
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) activityBySession.set(m.sessionId, m.lastActivityAt);
    }
    this.stuckNotified = this.stuckNotified || new Set();

    const liveSessions = this.raw.live.map((s) => {
      const { root, worktree } = worktreeRoot(s.cwd);
      // "Quiet" = busy but the transcript hasn't grown. Long quiet spells
      // usually mean the session is stalled (weak signal: it may just be
      // waiting on slow background work).
      let quietMin = null; // whole minutes so the state fingerprint stays stable
      if (s.status === 'busy') {
        const lastWrite = Math.max(
          activityBySession.get(s.sessionId) || 0,
          s.statusUpdatedAt || 0
        );
        if (lastWrite) {
          const q = Date.now() - lastWrite;
          if (q >= QUIET_FLAG_MS) quietMin = Math.floor(q / 60000);
          if (q >= QUIET_NOTIFY_MS && !this.stuckNotified.has(s.sessionId)) {
            this.stuckNotified.add(s.sessionId);
            if (!isProjectMuted(root, readConfig().mutedProjects)) sendNotification({
              title: `${friendlyName(root)} may be stuck`,
              body: `Busy with no output for ${quietMin} minutes — worth a look.`,
              sound: 'Basso',
            });
          }
        }
      }
      if (quietMin === null) this.stuckNotified.delete(s.sessionId);
      return {
        quietMin,
        pid: s.pid,
        sessionId: s.sessionId,
        cwd: s.cwd,
        projectPath: root,
        projectName: friendlyName(root),
        isWorktree: worktree !== null,
        name: s.name,
        model: modelBySession.get(s.sessionId) || null,
        title: titleBySession.get(s.sessionId) || s.name,
        status: s.status,
        waitingFor: s.waitingFor,
        startedAt: s.startedAt,
        statusUpdatedAt: s.statusUpdatedAt,
        currentTask: s.currentTask,
        tasksSummary: s.tasksSummary,
        subagents: subsBySession.get(s.sessionId) || null,
        resumeCommand: resumeCommand(s.cwd, s.sessionId),
      };
    });

    // Pinned sessions, newest first, resolved to display data.
    const pinnedIds = new Set(readConfig().pinnedSessions || []);
    const pinned = [];
    if (pinnedIds.size) {
      for (const g of this.raw.transcriptGroups.values()) {
        for (const m of g.sessions) {
          if (pinnedIds.has(m.sessionId)) {
            pinned.push({
              sessionId: m.sessionId,
              title: sessionTitle(m).title,
              projectName: friendlyName(g.path),
              model: m.model || null,
              lastActivityAt: m.lastActivityAt,
            });
          }
        }
      }
      pinned.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }

    // Trailing 8 weeks of estimated cost, oldest bucket first. Whole sessions
    // land in the bucket of their last activity — an approximation, but the
    // trend is what matters. Rounded to cents so the fingerprint stays stable.
    const DAY = 86400000;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const windowEnd = midnight.getTime() + DAY;
    const weeklyCost = new Array(8).fill(0);
    for (const g of this.raw.transcriptGroups.values()) {
      if (isIgnored(g.path)) continue;
      for (const m of g.sessions) {
        const idx = 7 - Math.floor((windowEnd - 1 - m.lastActivityAt) / (7 * DAY));
        if (idx >= 0 && idx < 8) weeklyCost[idx] += estimateCost(combinedUsage(m));
      }
    }
    for (let i = 0; i < 8; i++) weeklyCost[i] = Math.round(weeklyCost[i] * 100) / 100;

    // Weekly budget: compare the trailing-7-day estimate, alert once per
    // threshold crossing (75 / 90 / 100%), re-arm when spend drops back.
    const budgetLimit = readConfig().weeklyBudget || 0;
    const level = budgetLevel(weeklyCost[7], budgetLimit);
    if (level > (this.budgetAlerted || 0)) {
      this.budgetAlerted = level;
      sendNotification({
        title: 'Claude weekly budget',
        body: `7-day estimated spend ≈$${weeklyCost[7].toFixed(0)} — ${level >= 100 ? 'over' : `${level}% of`} your $${budgetLimit} budget.`,
        sound: 'Basso',
      });
    } else if (level < (this.budgetAlerted || 0)) {
      this.budgetAlerted = level;
    }
    const budget = budgetLimit ? { limit: budgetLimit, spent: weeklyCost[7], level } : null;

    const next = { quota: this.raw.quota, plan: readPlan(), liveSessions, projects, weeklyCost, budget, pinned, errors: this.state.errors.slice(-5) };
    const fp = JSON.stringify(next);
    if (fp !== this.fingerprint) {
      this.fingerprint = fp;
      this.state = { generatedAt: Date.now(), ...next };
      for (const fn of this.listeners) fn(this.state);
    }
  }

  // Every session for one project, uncapped — for the detail view.
  allSessions(projectPath) {
    const g = this.raw.transcriptGroups.get(projectPath.toLowerCase());
    if (!g) return [];
    return g.sessions.map((m) => {
      const { title, source } = sessionTitle(m);
      return {
        sessionId: m.sessionId,
        title,
        titleSource: source,
        estCost: estimateCost(combinedUsage(m)),
        awaySummary: m.awaySummary,
        startedAt: m.startedAt,
        lastActivityAt: m.lastActivityAt,
        worktree: m.worktree,
        resumeCommand: resumeCommand(m.cwd, m.sessionId),
      };
    });
  }

  // Aggregates for the stats view: daily activity, hour histogram,
  // per-model usage, totals. Ignored projects excluded throughout.
  statsSummary() {
    const DAY = 86400000;
    const perDay = new Map();
    const hours = new Array(24).fill(0);
    const allTimestamps = [];
    let promptTotal = 0;
    const weekCut = Date.now() - 7 * 86400000;
    let weekPrompts = 0;
    const weekDayNames = new Map(); // 'Monday' -> count, last 7 days
    const weekHours = new Array(24).fill(0);
    for (const e of this.raw.history.values()) {
      if (isIgnored(e.path)) continue;
      promptTotal += e.promptCount;
      allTimestamps.push(...e.timestamps);
      for (const t of e.timestamps) {
        const d = new Date(t);
        d.setHours(0, 0, 0, 0);
        perDay.set(d.getTime(), (perDay.get(d.getTime()) || 0) + 1);
        hours[new Date(t).getHours()]++;
        if (t >= weekCut) {
          weekPrompts++;
          const name = new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
          weekDayNames.set(name, (weekDayNames.get(name) || 0) + 1);
          weekHours[new Date(t).getHours()]++;
        }
      }
    }
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 181; i >= 0; i--) {
      const t = today.getTime() - i * DAY;
      days.push({ t, c: perDay.get(t) || 0 });
    }

    const byModel = {};
    const perProject = [];
    const sessionDays = [];
    let sessionTotal = 0;
    let costTotal = 0;
    const weekDayKey = dayKey(weekCut);
    let weekSessions = 0;
    let weekCost = 0;
    const weekProjects = new Map();
    const weekModels = new Set();
    const weekWaits = [0, 0, 0, 0];
    for (const g of this.raw.transcriptGroups.values()) {
      if (isIgnored(g.path)) continue;
      sessionTotal += g.sessions.length;
      const projModels = {};
      for (const m of g.sessions) {
        const mDays = combinedDays(m);
        sessionDays.push(mDays);
        if (m.lastActivityAt >= weekCut) {
          weekSessions++;
          if (m.waits) for (let i = 0; i < 4; i++) weekWaits[i] += m.waits[i];
          let mWeekCost = 0;
          for (const [day, byM] of Object.entries(mDays)) {
            if (day >= weekDayKey) {
              mWeekCost += estimateCost(byM);
              for (const model of Object.keys(byM)) weekModels.add(model);
            }
          }
          weekCost += mWeekCost;
          const pn = friendlyName(g.path);
          weekProjects.set(pn, (weekProjects.get(pn) || 0) + mWeekCost);
        }
        for (const [model, u] of Object.entries(combinedUsage(m))) {
          const e = byModel[model] || (byModel[model] = { tokens: 0, cost: 0 });
          const cost = estimateCost({ [model]: u });
          e.tokens += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
          e.cost += cost;
          projModels[model] = (projModels[model] || 0) + cost;
        }
      }
      const projTotal = Object.values(projModels).reduce((a, b) => a + b, 0);
      if (projTotal >= 0.01) {
        perProject.push({ name: friendlyName(g.path), total: projTotal, models: projModels });
      }
    }
    perProject.sort((a, b) => b.total - a.total);
    for (const e of Object.values(byModel)) costTotal += e.cost;
    return {
      days,
      hours,
      heat: weekHourHeat(allTimestamps),
      costDays: dailyCostSeries(sessionDays, 90),
      week: {
        sessions: weekSessions,
        prompts: weekPrompts,
        cost: Math.round(weekCost * 100) / 100,
        projects: [...weekProjects.entries()]
          .filter(([, c]) => c >= 0.01)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 })),
        models: [...weekModels],
        busiestDay: [...weekDayNames.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)[0] || null,
        busiestHour: weekHours.some((c) => c) ? weekHours.indexOf(Math.max(...weekHours)) : null,
        waits: weekWaits,
        typicalWait: typicalWait(weekWaits),
      },
      byModel,
      perProject: perProject.slice(0, 15),
      totals: { sessions: sessionTotal, prompts: promptTotal, cost: Math.round(costTotal * 100) / 100 },
    };
  }

  // Transcript file + title for one session, for the transcript viewer.
  findSessionFile(sessionId) {
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) {
        if (m.sessionId === sessionId) {
          return { file: m.file, title: sessionTitle(m).title, projectName: friendlyName(g.path) };
        }
      }
    }
    return null;
  }

  // Real cwd for a session (worktree sessions differ from their project path).
  findSession(sessionId) {
    for (const s of this.raw.live) {
      if (s.sessionId === sessionId) return { cwd: s.cwd, live: true };
    }
    for (const g of this.raw.transcriptGroups.values()) {
      for (const m of g.sessions) {
        if (m.sessionId === sessionId) return { cwd: m.cwd, live: false };
      }
    }
    return null;
  }

  noteError(source, err) {
    const msg = `${source}: ${String(err && err.message ? err.message : err).slice(0, 200)}`;
    this.state.errors.push({ at: Date.now(), message: msg });
    if (this.state.errors.length > 20) this.state.errors = this.state.errors.slice(-20);
  }
}

function resumeCommand(cwd, sessionId) {
  if (process.platform === 'win32') {
    return `cd /d "${cwd}" && claude --resume ${sessionId}`;
  }
  const safe = String(cwd).replace(/'/g, `'\\''`);
  return `cd '${safe}' && claude --resume ${sessionId}`;
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { Collector };
