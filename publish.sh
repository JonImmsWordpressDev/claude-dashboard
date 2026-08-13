#!/bin/bash
# Sync the current committed tree to the public repo (clean history stays clean:
# one commit per release). Usage: ./publish.sh "release message"
set -euo pipefail
MSG="${1:-Update}"
PUBLIC_REPO="git@github.com:JonImmsWordpressDev/claude-dashboard.git"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$(dirname "$0")" archive HEAD | tar -x -C "$TMP"
cd "$TMP"
git init -q -b main
git remote add origin "$PUBLIC_REPO"
git fetch -q origin main
git reset -q --soft origin/main
git add -A
if git diff --cached --quiet; then echo "nothing to publish"; exit 0; fi
git commit -q -m "$MSG"
git push -q origin main
echo "✓ published: $MSG"
