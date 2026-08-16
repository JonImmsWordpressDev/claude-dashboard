#!/usr/bin/env node
'use strict';
// npx claude-mission-control / global install entry point.
// Starts the server and opens the dashboard in the default browser.
// Pass --no-open to skip the browser (services use `node server.js` directly
// and never auto-open).
if (!process.argv.includes('--no-open')) process.env.CLAUDE_DASH_OPEN = '1';
require('../server.js');
