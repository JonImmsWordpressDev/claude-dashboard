#!/bin/bash
# Start the Mission Control MCP server (`claude-dashboard mcp`) for Claude Code.
# Runs only a global install that has the mcp subcommand: an older one would
# ignore `mcp` and start the dashboard server on this stdio channel instead.
# Downloads nothing; messages go to stderr, which Claude Code shows in /mcp.
PKG="claude-mission-control@1.24.0"
bin=$(command -v claude-dashboard 2>/dev/null) || {
  echo "Mission Control isn't installed globally. Install it with: npm install -g $PKG (or brew install claude-dashboard)" >&2
  exit 1
}
root=$(node -e 'const p=require("path"),fs=require("fs");console.log(p.resolve(p.dirname(fs.realpathSync(process.argv[1])),".."))' "$bin" 2>/dev/null)
# Homebrew keeps the package under libexec/ next to its wrapper script.
[ -f "$root/package.json" ] || [ ! -f "$root/libexec/package.json" ] || root="$root/libexec"
if [ ! -f "$root/lib/mcp.js" ]; then
  ver=$(node -p 'require(process.argv[1]).version' "$root/package.json" 2>/dev/null)
  echo "Your Mission Control (${ver:-unknown}) predates the MCP server. Update it with: npm install -g $PKG (or brew upgrade claude-dashboard)" >&2
  exit 1
fi
exec "$bin" mcp
