#!/usr/bin/env node
'use strict';
// Build the static, clickable demo into site/ for GitHub Pages.
//
// The real UI, unchanged, plus a small shim that answers its /api/* calls
// in the browser from lib/demo.js. The demo module is embedded as source
// rather than baked to JSON, so its relative timestamps ("started 47m ago")
// are fresh whenever someone opens the page.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site');
const { THEMES } = require('../lib/config');
const { version: VERSION } = require('../package.json');

const demoSource = fs.readFileSync(path.join(ROOT, 'lib', 'demo.js'), 'utf8').replace(/^'use strict';\n/, '');

const shim = `<script>
(function () {
  var module = { exports: {} };
  (function (module, exports) {
${demoSource}
  })(module, module.exports);
  var D = module.exports;
  var VERSION = ${JSON.stringify(VERSION)};
  var THEMES = ${JSON.stringify(THEMES)};
  var NOPE = 'this is the live demo. Install it to use this: npx claude-mission-control';

  function route(url, method) {
    var u = new URL(url, location.origin);
    var q = u.searchParams;
    var p = u.pathname;
    if (method !== 'GET') return { ok: false, demo: true, error: NOPE };
    switch (p) {
      case '/api/state': return D.demoState();
      case '/api/health': return { ok: true, demo: true, version: VERSION };
      case '/api/stats': return D.demoStats();
      case '/api/inventory': return D.demoInventory();
      case '/api/session': return D.demoSession(q.get('id'), q.get('after'));
      case '/api/session-changes': return D.demoChanges(q.get('id'), q.get('file'));
      case '/api/search': return { q: q.get('q') || '', prompts: [], titles: [], notes: [], transcripts: null };
      case '/api/project': return D.demoProject();
      case '/api/fame': return D.demoFame();

      case '/api/config': return {
        demo: true, notifications: true, usageApi: false, weeklyBudget: 200, idleNagMinutes: 60,
        terminals: [], resolvedTerminal: { id: 'terminal', label: 'Terminal' }, claudeApp: false,
        names: {}, ignores: [], themes: THEMES, version: VERSION, errors: [], pricingSource: null, unpricedModels: [],
      };
      default: return { ok: false, demo: true, error: NOPE };
    }
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    if (!/^\\/api\\//.test(url)) return realFetch(input, init);
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = JSON.stringify(route(url, method));
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };

  // The live stream: one 'state' event now, then every 5 seconds.
  window.EventSource = function () {
    var self = this;
    var listeners = {};
    self.readyState = 1;
    self.addEventListener = function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); };
    self.close = function () { clearInterval(timer); self.readyState = 2; };
    function emit() {
      var ev = new MessageEvent('state', { data: JSON.stringify(D.demoState()) });
      (listeners.state || []).forEach(function (fn) { fn(ev); });
    }
    var timer = setInterval(emit, 5000);
    setTimeout(function () { if (self.onopen) self.onopen(); emit(); }, 50);
  };
})();
</script>`;

const banner = `<style>@media (max-width: 700px) { #demo-banner { left: 16px !important; right: 16px; transform: none !important; font-size: 12px !important; } }</style>
<div id="demo-banner" style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:999;
  max-width:calc(100% - 32px);box-sizing:border-box;padding:10px 16px;border-radius:8px;
  background:var(--surface);color:var(--ink);border:1px solid var(--warn);box-shadow:0 6px 24px rgba(0,0,0,.35);
  font:13px 'JetBrains Mono',ui-monospace,monospace;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
  <span><b style="color:var(--warn)">Live demo</b> · invented projects and sessions. Run it on your own:</span>
  <code style="color:var(--accent)">npx claude-mission-control</code>
  <a href="https://github.com/JonImmsWordpressDev/claude-dashboard" style="color:var(--muted)">GitHub →</a>
  <button onclick="this.parentNode.remove()" aria-label="Dismiss" style="background:none;border:0;color:var(--muted);cursor:pointer;font:inherit">✕</button>
</div>`;

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const swaps = [
  [/url\('\/fonts\//g, "url('fonts/"],
  [/<link rel="manifest"[^>]*>\n?/, ''],
  [/<title>[^<]*<\/title>/, '<title>Claude Mission Control — live demo</title>\n<meta name="description" content="A clickable demo of Claude Mission Control, a local, read-only dashboard for every Claude Code session.">'],
];
for (const [re, to] of swaps) {
  if (!re.test(html)) throw new Error(`build-demo: pattern not found: ${re}`);
  html = html.replace(re, to);
}
// The shim must run before the UI script; the banner goes last in <body>.
const firstScript = html.indexOf('<script');
if (firstScript < 0 || !html.includes('</body>')) throw new Error('build-demo: unexpected index.html shape');
html = html.slice(0, firstScript) + shim + '\n' + html.slice(firstScript);
html = html.replace('</body>', banner + '\n</body>');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
for (const f of fs.readdirSync(path.join(ROOT, 'public', 'fonts'))) {
  fs.copyFileSync(path.join(ROOT, 'public', 'fonts', f), path.join(OUT, 'fonts', f));
}
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`demo built: ${path.relative(ROOT, OUT)}/index.html (v${VERSION})`);
