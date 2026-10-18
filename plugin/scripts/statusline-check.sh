#!/bin/bash
# Is `claude-dashboard statusline` usable? Prints one of:
#   READY <version>     installed and new enough
#   OUTDATED <version>  installed, but predates the statusline subcommand
#   MISSING             not installed globally
bin=$(command -v claude-dashboard 2>/dev/null) || { echo "MISSING"; exit 0; }
root=$(node -e 'const p=require("path"),fs=require("fs");console.log(p.resolve(p.dirname(fs.realpathSync(process.argv[1])),".."))' "$bin" 2>/dev/null)
# Homebrew keeps the package under libexec/ next to its wrapper script.
[ -f "$root/package.json" ] || [ ! -f "$root/libexec/package.json" ] || root="$root/libexec"
ver=$(node -p 'require(process.argv[1]).version' "$root/package.json" 2>/dev/null)
if [ -f "$root/lib/statusline.js" ]; then echo "READY ${ver:-unknown}"; else echo "OUTDATED ${ver:-unknown}"; fi
