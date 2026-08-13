#!/bin/bash
# Install the Claude Dashboard as a macOS LaunchAgent (always-on, starts at login).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.claude-dashboard"
PLIST_SRC="$APP_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${CLAUDE_DASH_PORT:-4517}"

NODE_PATH_BIN="$(command -v node || true)"
if [ -z "$NODE_PATH_BIN" ]; then
  echo "error: node not found on PATH. Install Node.js first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# LaunchAgents don't inherit your shell PATH — bake in the absolute node path.
sed -e "s|__NODE_PATH__|$NODE_PATH_BIN|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# migrate installs made under the pre-release label
launchctl bootout "gui/$(id -u)/com.jonimms.claude-dashboard" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.jonimms.claude-dashboard.plist"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo -n "waiting for server"
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    echo "✓ claude-dashboard is running at http://127.0.0.1:$PORT"
    echo "  Open it in Safari and use File → Add to Dock for an app-like window."
    echo "  Logs: ~/Library/Logs/claude-dashboard.log"
    exit 0
  fi
  echo -n "."
  sleep 0.5
done
echo
echo "error: server did not respond on port $PORT. Check ~/Library/Logs/claude-dashboard.log" >&2
exit 1
