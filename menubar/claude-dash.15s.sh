#!/bin/bash
# SwiftBar plugin for the Claude Dashboard. Refreshes every 15s (filename).
# <swiftbar.title>Claude Dashboard</swiftbar.title>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>

PORT="${CLAUDE_DASH_PORT:-4517}"
STATE=$(curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/state" 2>/dev/null)

if [ -z "$STATE" ]; then
  echo "❯ · | color=gray"
  echo "---"
  echo "Dashboard server offline"
  echo "Open dashboard | href=http://127.0.0.1:$PORT"
  exit 0
fi

echo "$STATE" | /usr/bin/python3 -c '
import json, sys, time

s = json.load(sys.stdin)
live = s.get("liveSessions", [])
projects = s.get("projects", [])
waiting = [l for l in live if l.get("status") == "waiting"]
quiet = [l for l in live if l.get("quietMin")]

# Menu bar title: attention states change the glyph so it reads at a glance.
if waiting:
    print(f"❯ {len(waiting)}⚠ | color=#e0a63a")
elif quiet:
    print(f"❯ {len(live)}?")
elif live:
    print(f"❯ {len(live)}")
else:
    print("❯ | color=gray")

print("---")

def elapsed(ms):
    if not ms: return ""
    m = int((time.time() * 1000 - ms) / 60000)
    return f"{m//60}h {m%60}m" if m >= 60 else f"{m}m"

if live:
    for l in live:
        name = l.get("projectName", "?")
        if l.get("status") == "waiting":
            what = l.get("waitingFor") or "waiting"
            print(f"{name} — {what} | color=#e0a63a")
        elif l.get("quietMin"):
            qm = l.get("quietMin")
            print(f"{name} — busy, quiet {qm}m | color=#e0a63a")
        else:
            task = (l.get("currentTask") or {}).get("activeForm") or "busy"
            age = elapsed(l.get("startedAt"))
            print(f"{name} — {task} ({age})")
else:
    print("No sessions running | color=gray")

attn = []
for p in projects:
    g = p.get("git") or {}
    if not g.get("isRepo"): continue
    changes = (g.get("dirty") or 0) + (g.get("untracked") or 0)
    ahead = g.get("ahead") or 0
    if changes or ahead:
        bits = (f"●{changes}" if changes else "") + (f" ↑{ahead}" if ahead else "")
        pname = p.get("name")
        attn.append(f"{pname} {bits.strip()}")
if attn:
    print("---")
    print(f"Unpushed work — {len(attn)} repos | color=gray")
    for a in attn[:8]:
        print(a)

spend = sum(p.get("spend7d") or 0 for p in projects)
print("---")
if spend >= 0.005:
    print(f"7d est. value ≈${spend:.0f} | color=gray")
print("Open dashboard | href=http://127.0.0.1:'"$PORT"'")
'
