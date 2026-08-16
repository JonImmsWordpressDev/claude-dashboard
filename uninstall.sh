#!/bin/bash
# Remove the Claude Dashboard service (LaunchAgent on macOS, systemd user unit on Linux).
set -euo pipefail

LABEL="com.claude-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$(uname -s)" = "Linux" ]; then
  systemctl --user disable --now claude-dashboard.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/claude-dashboard.service"
  systemctl --user daemon-reload
  echo "✓ claude-dashboard systemd unit removed. (Repo left in place.)"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ claude-dashboard LaunchAgent removed. (Repo and logs left in place.)"
