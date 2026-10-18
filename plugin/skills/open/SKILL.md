---
name: open
description: Start the Mission Control dashboard if it isn't running and open it in the browser.
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/scripts/ensure-running.sh")
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/scripts/ensure-running.sh"`

The script above has already run, and the line above is its output. Do not run it again or use any tools. Tell the user in one short line what it says: the dashboard URL, or what went wrong and how to fix it.
