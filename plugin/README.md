# Mission Control plugin

Opens Claude Mission Control, a local, read-only dashboard for every Claude Code session on your machine: which session is waiting on you, what each one costs, when you will hit your usage limit, and what each session changed.

## Commands

- `/mission-control:open` starts the dashboard if it is not running and opens it in your browser.
- `/mission-control:statusline` checks that your installed version supports the statusline, then shows the one setting to add to `~/.claude/settings.json`. It only edits that file if you say yes.

## What it runs, sends, and fetches

- `scripts/ensure-running.sh` checks `http://127.0.0.1:4517/api/health`. If nothing answers, it starts your global `claude-dashboard` install. Without one, it downloads nothing: it prints the pinned command (`npx claude-mission-control@1.18.0`) for you to run yourself. Once the dashboard is up, it opens the dashboard URL with `open` (macOS) or `xdg-open` (Linux).
- `scripts/statusline-check.sh` finds your `claude-dashboard` install and reads its `package.json` version. It makes no network calls.
- The plugin has no hooks, no MCP servers, and no background processes.

The dashboard itself binds to 127.0.0.1, never writes to `~/.claude`, and makes one optional network call: Anthropic's usage endpoint for the limit meters, using the sign-in Claude Code already has. You can turn that off in its settings.

Source, docs, and a live demo: https://github.com/JonImmsWordpressDev/claude-dashboard

License: MIT
