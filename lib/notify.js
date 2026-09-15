'use strict';
// macOS notifications via osascript — no dependencies, no signing.
// Disable with CLAUDE_DASH_NOTIFY=0.
const { execFile } = require('child_process');
const { readConfig } = require('./config');
const { canonicalize } = require('./paths');

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
  if (process.platform === 'darwin') {
    const script =
      `display notification "${aq(body)}" with title "${aq(title)}"` +
      (sound ? ` sound name "${aq(sound)}"` : '');
    execFile('osascript', ['-e', script], { timeout: 5000 }, () => {});
  } else if (process.platform === 'win32') {
    // Windows toast via WinRT — no modules required. Untested; best effort.
    const esc = (s) => String(s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
    const ps = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$null = $t.Item(0).AppendChild($xml.CreateTextNode('${esc(title)}'))
$null = $t.Item(1).AppendChild($xml.CreateTextNode('${esc(body)}'))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Dashboard').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 }, () => {});
  } else {
    execFile('notify-send', [title, body], { timeout: 5000 }, () => {});
  }
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

// Sessions waiting longer than thresholdMs that haven't been nagged yet,
// oldest wait first. thresholdMs <= 0 disables the feature.
function overdueWaits(now, waitingSince, thresholdMs, alreadyNotified) {
  if (!(thresholdMs > 0)) return [];
  const out = [];
  for (const [id, since] of waitingSince) {
    if (alreadyNotified.has(id)) continue;
    if (now - since >= thresholdMs) out.push([since, id]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.map(([, id]) => id);
}

// Per-project mute: compare canonical, lowercased roots.
function isProjectMuted(root, mutedProjects) {
  if (!Array.isArray(mutedProjects) || !mutedProjects.length) return false;
  const key = canonicalize(root).toLowerCase();
  return mutedProjects.some((p) => canonicalize(p).toLowerCase() === key);
}

// Wait clocks: start when a session enters 'waiting' (or is already waiting
// when first seen), clear when it leaves or disappears. Mutates both
// collections; pure in the sense of no I/O, so it is unit-testable.
function trackWaits(next, waitingSince, idleNotified, now) {
  for (const [id, status] of next) {
    if (status === 'waiting') { if (!waitingSince.has(id)) waitingSince.set(id, now); }
    else { waitingSince.delete(id); idleNotified.delete(id); }
  }
  for (const id of [...waitingSince.keys()]) {
    if (!next.has(id)) { waitingSince.delete(id); idleNotified.delete(id); }
  }
}

module.exports = { sendNotification, newlyWaiting, overdueWaits, isProjectMuted, trackWaits };
