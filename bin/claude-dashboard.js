#!/usr/bin/env node
'use strict';
// npx claude-mission-control / global install entry point.
// Starts the server and opens the dashboard in the default browser.
// Pass --no-open to skip the browser (services use `node server.js` directly
// and never auto-open).
// `claude-dashboard statusline` prints one line for Claude Code's statusLine
// setting instead of starting anything.
if (process.argv[2] === 'statusline') {
  require('../lib/statusline').runStatusline();
} else {
  if (!process.argv.includes('--no-open')) process.env.CLAUDE_DASH_OPEN = '1';
  require('../server.js');
}
