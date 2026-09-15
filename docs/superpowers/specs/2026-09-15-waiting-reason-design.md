# Waiting reason — design

Date: 2026-09-15. Feature 1 of the September 2026 batch.

## Problem

The departures board flips a session to amber "needs you" but never says what
it needs. The live session file (`~/.claude/sessions/<pid>.json`) has a
`waitingFor` field that Claude Code does not populate in practice, so the
reason has to be derived from the transcript.

## Behaviour

For every live session whose status is `waiting`, the dashboard shows a
one-line reason under the session title in the departures row, uses the same
text in the macOS notification body and the catch-up log, and exposes the
full text in the row tooltip.

Three kinds of reason, in priority order:

| kind | condition | text |
|---|---|---|
| `question` | last assistant turn contains an `AskUserQuestion` tool_use with no matching tool_result | first question's `question`, plus its option labels |
| `permission` | last assistant turn contains any other tool_use with no matching tool_result | tool name and a short argument: Bash `command`, or the `file_path`/`path`/`url`-like first string arg; capped at 120 chars |
| `reply` | otherwise, last assistant turn ended with text | last line of the final text block that ends in `?`; else first line of the final paragraph |

Returns `null` when the tail holds no assistant turn. `waitingFor` from the
session file, when non-empty, wins over the derived reason.

## Data

`lib/transcripts.js` gains an exported pure function:

```
waitingReason(records) -> { kind, text, options? } | null
```

`records` are the already-parsed tail records (newest last) that
`scanTranscript` reads for `last-prompt` / `away_summary`. The tail buffer
(`TAIL_BYTES`) is sufficient: a pending question is always within the last
few records. No additional file reads.

`scanFile` derives the reason from that already-parsed tail for every
session, since the tail is parsed regardless — this costs nothing extra. The
collector exposes `waitingReason` in state only for sessions with live status
`waiting`, so idle sessions don't show one. Text is trimmed,
whitespace-collapsed, and truncated before it enters state so the JSON
fingerprint stays stable between polls.

Matching a tool_use to its tool_result: a `user` record whose content
includes `{ type: 'tool_result', tool_use_id }` equal to the tool_use `id`.
"Last assistant turn" means the assistant records after the last `user`
record that carries plain text (not a tool_result).

## State

Each entry in `state.live[]` gains `waitingReason: { kind, text, options } | null`.
`options` is present only for `question`, capped at 6 labels of 40 chars.

## UI (`public/index.html`)

- Departures row: a second line under the title, class `dep-reason`, muted
  colour, prefixed by a glyph: `?` for question, a lock glyph for permission,
  none for reply. Question options append as ` · a / b / c`. Truncated at 80
  characters with ellipsis; the full text is the line's `title`.
- Rendered only when `status === 'waiting'` and a reason exists. Busy rows
  keep their current height.
- Mission Control pane header shows the same line when its session is waiting.

## Notifications and catch-up

`collector.js` already passes `s.waitingFor || 'Claude is waiting for your
input'` to both. Replace with the resolved reason text (kind-prefixed for
`permission`: "permission: Bash npm test").

## Demo mode

`lib/demo.js`: the waiting demo session gets a `question` reason with three
options; add one `permission` example so both glyphs appear in screenshots.

## Tests (`test/pure-logic.test.js`)

Fixtures for: question pending; question already answered (falls through);
Bash permission; file-edit permission; reply ending in `?`; reply without a
question mark; empty/partial trailing line; no assistant turn → null.

## Out of scope

Answering from the dashboard. Any write to `~/.claude`.
