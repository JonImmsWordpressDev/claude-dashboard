#!/bin/bash
# Remove the Claude Dashboard LaunchAgent.
set -euo pipefail

LABEL="com.claude-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ claude-dashboard LaunchAgent removed. (Repo and logs left in place.)"
