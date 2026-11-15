'use strict';
// Request guards for the main listener. Pure, so they're unit-testable.
//
// DNS rebinding: a page on evil.example can re-point its own name at
// 127.0.0.1 and then read our GET routes as same-origin. The browser still
// sends `Host: evil.example`, so an EXACT hostname match on the Host header
// is the defence. A prefix match is not: `localhost.evil.example` is a name
// an attacker controls.

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Hostname part of a Host header value, lowercased: 'LocalHost:4517' ->
// 'localhost', '[::1]:4517' -> '[::1]'. Empty string for garbage.
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? '' : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

// `bindHost` is what the server listens on. Accepted: loopback names, any
// name the user listed in `extraHosts` (CLAUDE_DASH_ALLOWED_HOSTS — e.g. the
// MagicDNS name `tailscale serve` forwards), and, when bound off-loopback,
// the bind address itself. A wildcard bind (0.0.0.0) adds nothing: list names.
function allowedHost(hostHeader, bindHost, extraHosts = []) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (LOOPBACK_NAMES.has(name)) return true;
  if (extraHosts.some((h) => hostnameOf(h) === name)) return true;
  return bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0' && bindHost !== '::' && !!bindHost && name === bindHost.toLowerCase();
}

// For state-changing routes. Browsers always send Origin on cross-origin
// POSTs; a missing Origin means a non-browser client (curl), which the Host
// check has already vetted. A present Origin must name exactly the host the
// request was sent to, so a page can never POST across origins, whatever
// the bind address.
function sameOrigin(originHeader, hostHeader) {
  if (originHeader === undefined) return true;
  let origin;
  try {
    origin = new URL(String(originHeader));
  } catch {
    return false; // includes the literal 'null' origin from sandboxed frames
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
  return origin.host.toLowerCase() === String(hostHeader || '').trim().toLowerCase();
}

function parseAllowedHosts(env) {
  return String(env || '').split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { hostnameOf, allowedHost, sameOrigin, parseAllowedHosts };
