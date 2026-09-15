# Session changes (files touched, with diffs) — design

Date: 2026-09-15. Feature 3 of the September 2026 batch.

## Problem

The digest says what a session did in prose; nothing shows which files Claude
edited or what changed. Claude Code already keeps pre-edit backups under
`~/.claude/file-history/<sessionId>/<hash>@v<n>` and logs the mapping in the
transcript, so the data exists and is cheap to index.

## Facts about the source

- Transcript record `file-history-delta`: `{ trackingPath, backup: { backupFileName, version, backupTime, realParentDir } }` — one per edit.
- Transcript record `file-history-snapshot`: `{ snapshot: { trackedFileBackups: { <relPath>: { backupFileName, version, backupTime, realParentDir } } } }` — a full map at a point in time; may be empty.
- Real path = `realParentDir` + basename of the key/trackingPath.
- Backup `v1` is the file before Claude's first edit in that session; the highest version matches the state after the last edit (verified against disk).
- Backups are ~5 MB total for 26 sessions; individual files can be large.

## Data collection (`lib/transcripts.js`)

`incrementalScan` learns both record types and maintains on the cached
`scan` object:

```
changes: { [realPath]: { versions: [{ v, backup, at }], first, last } }
changeCount: number   // distinct paths
```

Snapshot entries merge by path and version (a snapshot that repeats a version
already seen from a delta is a no-op). This rides the append-only read, so
the no-full-parse property is preserved. Subagent transcripts are scanned
the same way and merged into the parent's map.

Only `changeCount` enters the assembled state (as `changeCount` on session
entries). The full map stays in the per-file cache and is read on demand.

## Diff module (`lib/diff.js`)

Pure, dependency-free line diff (Myers, O(ND)) with a hunk builder:

```
diffLines(a: string, b: string, { context = 3, maxChanges = 2000 })
  -> { hunks: [{ aStart, aLines, bStart, bLines, lines: [[' '|'+'|'-', text]] }],
       added, removed, truncated }
```

Limits: inputs over 400 KB per side return `{ tooLarge: true }`; output stops
after `maxChanges` changed lines with `truncated: true`. Both sides are split
on `\n` with a trailing-newline flag preserved.

## Endpoint (`server.js`)

`GET /api/session-changes?id=<sessionId>[&file=<n>&from=<v>&to=<v|disk>]`

- `id` must resolve via `collector.findSession()`; otherwise 404.
- Without `file`: returns `{ files: [{ n, path, rel, versions, first, last, exists, added, removed }] }`. `rel` is the path relative to the project root when inside it, else the absolute path. `added`/`removed` are from `diffLines(v1, disk)`; for a missing file, `disk` is empty and `exists: false`.
- With `file`: `n` indexes the server-side file list; `from` defaults to `1`, `to` defaults to `disk`. Returns `{ path, from, to, ...diffLines result }`. A missing backup file returns `{ missingBackup: true }`.
- Backup reads are confined to `~/.claude/file-history/<sessionId>/` and the file name is taken from the scan map, never from the client. Disk reads use the real path from the scan map. Read-only throughout.
- Not part of polled state; no SSE impact.

## UI (`public/index.html`)

- Transcript viewer header: `changes Δ n` button beside `export`, hidden when `n === 0`. Opens a panel over the transcript (same overlay pattern as search-in-transcript).
- Panel: list of files sorted by `last` desc, each row `rel  +added −removed  [deleted]`. Click expands to a unified diff, rendered with the theme's added/removed tones, line numbers on both sides, hunk headers. `truncated` shows a footer line; `tooLarge` shows a notice instead of a diff.
- Expanded rows have a selector: `net (v1 → now)` plus `v1 → v2`, `v2 → v3`, … for per-edit views.
- `Δ n` chip on session rows (project cards, digest, pinned strip, project slide-over). Clicking opens the transcript with the changes panel already open.
- Demo mode serves a small fixture with two files and a deleted one.

## Tests

- `lib/diff.js`: identical inputs; pure insert; pure delete; replace in the middle; two distant edits produce two hunks; near edits merge into one hunk; trailing newline preserved; `maxChanges` truncation; `tooLarge`.
- Scan: a delta record; a snapshot with two entries; a snapshot repeating a delta's version; `changeCount` equals distinct paths.
- Endpoint helper (pure): file-list assembly from a scan map and a stat function.

## Out of scope

Reverting files. Diffs for sessions whose backups have been cleaned up (rows show "backup gone").
