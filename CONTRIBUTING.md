# Contributing

Thanks for looking. This project is deliberately small: plain Node ≥ 18, zero npm dependencies, one server file plus focused modules in `lib/`, one HTML file for the whole UI. Please keep it that way — a PR that adds a dependency needs a very good reason.

## Getting started

1. Clone, then `node server.js` (or `CLAUDE_DASH_DEV=1 node server.js` to re-read `index.html` on every request while hacking on the UI).
2. Open http://127.0.0.1:4517 — it reads your real `~/.claude` data, read-only.
3. `npm test` runs the pure-logic tests. New logic in `lib/` should come with tests where it's a pure function.

## Ground rules

- **Read-only toward Claude's data.** Nothing under `~/.claude` is ever written.
- **Local-only by default.** No network calls except the user-initiated update check. Anything that phones home will be rejected.
- **The `/api/open` family executes commands** — any change there needs the same care as the existing code: validate inputs against known state, never trust the client.
- Match the existing style: small modules, comments only where the code can't speak.

## Windows

Windows support is experimental and was written on a Mac. Testing reports are the most valuable contribution there — use the Windows issue template even if everything worked.
