---
name: statusline
description: Set up the Mission Control statusline, which shows sessions waiting on you, context use, and your limit forecast.
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/scripts/statusline-check.sh")
disable-model-invocation: true
---

Install check (already run, do not run it again): !`"${CLAUDE_PLUGIN_ROOT}/scripts/statusline-check.sh"`

The Mission Control statusline is the command `claude-dashboard statusline`. It reads Claude Code's statusline input and, when the dashboard is running, adds other sessions waiting on the user and the limit forecast. Example output:

`❯ acme-storefront needs you · Opus 5.5 · ctx 41% · 5h 64% → 3:40 PM · $3.20`

If the check printed MISSING, tell the user to install the package first, and show them the exact command: `npm install -g claude-mission-control@1.22.0` (or `brew install claude-dashboard`). If it printed OUTDATED, tell them their installed version is too old for the statusline and show them the update command: `npm install -g claude-mission-control@1.22.0` (or `brew upgrade claude-dashboard`). Do not run either command yourself; the user runs it. Do not show the settings block until the check says READY, because an older version would try to start the server from the statusline. The statusline runs every few seconds, so it can't go through npx.

Then show them this block for `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-dashboard statusline",
    "padding": 0
  }
}
```

Say that it replaces any statusline they already have. Offer to add it for them. Only edit `~/.claude/settings.json` if they say yes, and merge the `statusLine` key into the existing file rather than overwriting it.
