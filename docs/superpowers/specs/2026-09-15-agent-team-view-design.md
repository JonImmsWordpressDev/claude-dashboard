# Agent team view — design

Date: 2026-09-15. Feature 10 of the September 2026 batch.

## Behaviour

When a session runs subagents or an agent team, Mission Control shows a
compact tree under that pane's header: team name, then one row per agent
with its declared colour, model, and a live dot or done tick. The transcript
viewer header shows the same list statically for finished sessions.

## Sources (read-only)

- `<transcriptDir>/<sessionId>/subagents/agent-a<name>-<16 hex>.meta.json` for
  named agents, or `agent-a<16 hex>.meta.json` for unnamed ones (note the
  leading `a` right after `agent-`): `{ name, agentType, description, model,
  teamName, color, taskKind }`. `name` is frequently absent (about half of
  observed metas); fall back to `description`, then the name parsed from the
  file, then `#<hash prefix>`.
- The sibling `.jsonl` is created first; the `.meta.json` can land minutes to
  hours later (or not at all if the agent died before writing it), so it is
  read on every rescan of a changed transcript until it is successfully
  parsed, then never re-read. The sibling `.jsonl` mtime gives freshness.
- `~/.claude/teams/<teamName>/config.json`: `{ name, description, leadSessionId, members: [{ name, agentType, model, cwd }] }`.

## Data (`lib/transcripts.js`, `lib/collector.js`)

The existing subagent scan already lists the `.jsonl` files; it additionally
reads each `.meta.json` (small, cached by mtime, retried until it parses) and
records `{ name, type, model, color, team, description, lastWriteAt }`.

Collector adds to each live session entry:

```
agents: { team: string|null, list: [{ name, type, model, color, status }] } | null
```

`status` is `active` when `lastWriteAt` is within 120 s of now, else `done`.
Status is derived to a whole value so the fingerprint stays stable; the
`lastWriteAt` timestamp itself is not included in state. Team name comes
from the meta `teamName`, or from a `teams/*/config.json` whose
`leadSessionId` matches. Sessions with no subagents get `null`.

Finished sessions expose the same structure via `/api/session` (transcript
view) with every status `done`.

## UI

- Mission Control pane: a `mc-agents` block under the header, one line per
  agent: colour swatch (from `color`, mapped to the theme's named tones),
  name, model chip, `●` pulsing when active or `✓` when done. Team name as a
  small heading when present. Collapsible per pane, state remembered in
  `localStorage`.
- Transcript viewer header: static list with the same markup, no pulse.
- Existing `⑂ n` chip remains on session rows.

## Tests

Pure `agentStatus(lastWriteAt, now)` boundary; `resolveTeam(meta, teams,
sessionId)` precedence; `.meta.json` parse tolerance (missing fields).

## Out of scope

Opening a subagent's transcript from the tree (their transcripts remain
merged into the parent view); anything under `~/.claude/teams` beyond
reading `config.json`.
