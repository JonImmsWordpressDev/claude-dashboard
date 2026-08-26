# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, read-only dashboard for Claude Code sessions: plain Node.js ≥ 18, **zero npm dependencies** (a PR adding one needs a very good reason), one server file plus focused modules in `lib/`, and a single `public/index.html` containing the entire UI (inline CSS + JS). macOS-first; Windows support is experimental and untested on real Windows.

## Commands

```bash
node server.js                       # run the server (http://127.0.0.1:4517)
CLAUDE_DASH_DEV=1 node server.js     # re-read index.html on every request (UI dev)
npm test                             # node --test test/pure-logic.test.js (the only test file)
launchctl kickstart -k gui/$(id -u)/com.claude-dashboard   # restart the installed LaunchAgent after changes
```

To run a single test: `node --test --test-name-pattern="<name>" test/pure-logic.test.js`.

There is no build, lint, or bundling step. Logs for the installed service: `~/Library/Logs/claude-dashboard.log`.

## Hard rules

- **Never write to anything under `~/.claude`.** All Claude data is read-only.
- **No network calls** except three, all user-initiated or toggleable: the Keychain-authed Anthropic OAuth usage fetch (`lib/usage.js`, toggleable, in-memory token only — never written or logged), the GitHub update check in `server.js`, and the self-update in `lib/update.js` (runs `git pull` / `npm install -g` — fixed commands, never client input). Anything else that phones home will be rejected.
- **The `/api/open` family executes shell commands.** Any change there (or in `lib/opener.js`) must validate inputs against collector-known state — session IDs, project paths — never trust client-supplied paths. The existing pattern: look the request up in `collector.projectPaths()` / `collector.findSession()` and use the server-side value.
- Server binds `127.0.0.1` only by default; POST endpoints enforce same-origin.

## Architecture

`server.js` is a plain `http` server: serves `public/index.html`, a handful of `/api/*` JSON endpoints, and an SSE stream at `/api/events` that pushes the full state object whenever it changes.

The heart is `lib/collector.js` (`Collector`): four independent refresh loops (`live`, `scan`, `git`, `quota`) each re-read their source, then `assemble()` merges everything into one `state` object. A JSON fingerprint diff decides whether to notify SSE listeners — so anything included in state must be stable between polls (values are rounded/floored deliberately for this). Loop cadence switches between `active` and `idle` based on connected SSE client count.

Data sources (all under `~/.claude`), each with its own module:

- `lib/sessions.js` — live sessions from `~/.claude/sessions/<pid>.json`, liveness verified against the pid
- `lib/transcripts.js` — the scanning strategy that makes everything cheap: transcript `.jsonl` files reach 14MB and are **never fully parsed**. Head read (cwd/branch/first prompt), tail read (last-prompt/away-summary), plus an incremental streaming pass that only reads bytes appended since the last scan (accumulating ai-title, per-model token usage deduped by message id, last model). Cached by (mtime, size). Subagent transcripts under `<sessionId>/subagents/` are scanned the same way and merged via `combinedUsage()`. Preserve this no-full-parse property in any transcript change.
- `lib/history.js`, `lib/registry.js`, `lib/tasks.js`, `lib/gitstatus.js` (parses `git status --porcelain=v2`), `lib/plan.js`, `lib/quota.js` (statusline-cache fallback), `lib/usage.js` (OAuth usage, macOS Keychain)

Cross-cutting helpers: `lib/paths.js` defines the canonical path form (resolved, forward slashes, no trailing slash, compared lowercase) used for all internal keys — worktree sessions (`<repo>/.claude/worktrees/<name>`) fold into their parent repo via `worktreeRoot()`. `lib/config.js` owns the three gitignored user files at repo root (`config.json`, `names.json`, `ignore.json`), read fresh-by-mtime and written pretty-printed so they stay hand-editable.

On-demand (not part of the polled state): `lib/detail.js` (project slide-over), `lib/transcript-view.js` (transcript viewer, supports incremental `after` offset for live-following), `lib/search.js`.

## Conventions

- Small modules; comments only where the code can't speak.
- New logic in `lib/` should come with tests **where it's a pure function** — pure parts are exported specifically so `test/pure-logic.test.js` can hit them (e.g. `parsePorcelainV2`, `newlyWaiting`, `matchesPrefix`, `estimateCost`). Tests use `node:test` + `node:assert`, no framework.
- Windows paths are handled in the pure path helpers (drive letters, backslashes) and covered by tests; keep cross-platform behavior in `lib/paths.js` rather than scattering `process.platform` checks.
