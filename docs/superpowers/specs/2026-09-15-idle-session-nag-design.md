# Idle session nag — design

Date: 2026-09-15. Feature 11 of the September 2026 batch.

## Behaviour

A session that has been waiting on you for longer than a configurable
threshold triggers one notification and a catch-up entry, and its departures
row shows how long it has been waiting in amber. Nothing repeats until the
session leaves `waiting`.

## Config (`lib/config.js`)

`idleNagMinutes: number`, default `60`, `0` disables. Exposed in the settings
panel under notifications as a number input. Writes `config.json` like the
other settings.

## Data (`lib/collector.js`)

The collector already tracks status transitions per session (`newlyWaiting`).
Add `waitingSince: Map<sessionId, ts>` set when a session enters `waiting`
and cleared when it leaves. Add `idleNotified: Set<sessionId>`, cleared on
the same transition.

Pure helper in `lib/notify.js`:

```
overdueWaits(now, waitingSince, thresholdMs, alreadyNotified) -> sessionId[]
```

Returns ids whose wait exceeds the threshold and are not yet in
`alreadyNotified`. Threshold `<= 0` returns `[]`.

Each id returned: send a notification titled `<project> still needs you`
with body from the feature-1 waiting reason (or the generic text), log a
catch-up event of kind `still waiting`, add to `idleNotified`. Per-project
mute (`isProjectMuted`) applies.

## State

Live session entries gain `waitingMin: number | null` — whole minutes since
the session entered `waiting`, `null` when not waiting or below the
threshold. Whole minutes keep the fingerprint stable.

## UI

Departures row elapsed cell shows `waiting 1h 12m` in amber when
`waitingMin` is set. Mission Control pane header shows the same. Menu bar
script marks such sessions with `⏳` after the existing `⚠`.

## Tests

`overdueWaits`: below threshold; above; already notified; threshold 0; mixed.

## Out of scope

Escalating repeat reminders; auto-closing sessions.
