'use strict';
// macOS notifications via osascript — no dependencies, no signing.
// Disable with CLAUDE_DASH_NOTIFY=0.
const { execFile } = require('child_process');
const { readConfig } = require('./config');

function notificationsEnabled() {
  if (process.env.CLAUDE_DASH_NOTIFY === '0') return false;
  return readConfig().notifications !== false;
}

function aq(s) {
  // AppleScript string literal: escape backslash and double quote.
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sendNotification({ title, body, sound }) {
  if (!notificationsEnabled()) return;
  const script =
    `display notification "${aq(body)}" with title "${aq(title)}"` +
    (sound ? ` sound name "${aq(sound)}"` : '');
  execFile('osascript', ['-e', script], { timeout: 5000 }, () => {});
}

// Pure transition detector so it's unit-testable.
// prev/next: Map<sessionId, status>; prev === null means first poll after
// startup — never notify then, or every restart would replay notifications.
// A session unseen in prev but waiting in next DOES notify (it went waiting
// between polls).
function newlyWaiting(prev, next) {
  if (prev === null) return [];
  const out = [];
  for (const [id, status] of next) {
    if (status === 'waiting' && prev.get(id) !== 'waiting') out.push(id);
  }
  return out;
}

module.exports = { sendNotification, newlyWaiting };
