#!/bin/bash
# Start the Mission Control dashboard if it isn't running, then open it.
# Uses a global install. If there isn't one, prints the pinned command to run
# instead of downloading anything itself.
PORT="${CLAUDE_DASH_PORT:-4517}"
PKG="claude-mission-control@1.21.0"
URL="http://127.0.0.1:$PORT"

up() { curl -sf --max-time 1 "$URL/api/health" >/dev/null 2>&1; }

if up; then
  started="already running"
else
  if command -v claude-dashboard >/dev/null 2>&1; then
    nohup claude-dashboard --no-open >/dev/null 2>&1 &
  elif command -v npx >/dev/null 2>&1; then
    echo "Mission Control isn't installed. Run this in a terminal to start it: npx $PKG (or install it with: npm install -g $PKG)"
    exit 1
  else
    echo "Node.js isn't installed. Install it from https://nodejs.org, then run: npx $PKG"
    exit 1
  fi
  for _ in $(seq 1 60); do up && break; sleep 0.5; done
  if ! up; then
    echo "The dashboard didn't start within 30 seconds. Try running: claude-dashboard"
    exit 1
  fi
  started="started"
fi

case "$(uname)" in
  Darwin) open "$URL" ;;
  Linux) xdg-open "$URL" >/dev/null 2>&1 ;;
esac
echo "Mission Control $started at $URL"
