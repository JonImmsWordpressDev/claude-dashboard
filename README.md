# Claude Dashboard

One web page that shows you everything Claude Code is doing on your machine.

Claude Code runs in a terminal. Once you have two or three sessions going, you lose track. Which one is waiting for an answer? What did that session change while you were away? How much has this week cost? Claude Dashboard answers those questions on one screen, updated live, from the files Claude Code already writes to `~/.claude`.

**What you get**

- A departures board of every running session. When Claude stops to ask you something, the row turns amber and shows the question, so you go straight to the right terminal.
- A diff of every file Claude edited or created in a session, taken from the backups Claude Code keeps. Read what changed before you commit it.
- The full transcript of any session, past or present, and a search across every prompt you have ever sent.
- Cost per project, per model, and per week, estimated from the tokens in your transcripts.
- A macOS notification the moment a session needs you, and a reminder if you leave it waiting.

**Why you would want it**

- You stop checking terminals. The board and the notifications tell you when to look.
- You stop losing sessions. Every session has a resume button that reopens it in the right folder.
- You see where the time and the money go, per project.
- It is read-only. It never writes to Claude's files. Nothing leaves your Mac except one optional call to Anthropic's usage API for your quota meters, using the sign-in Claude Code already has.
- Nothing to configure. No API keys. Plain Node.js, zero npm dependencies, bound to `127.0.0.1` only.

**Who it is for:** anyone who runs Claude Code in more than one terminal.

**Requirements:** macOS or Linux (Windows experimental, see below), Node.js ≥ 18, Claude Code.

![Claude Dashboard, dark mode: three live sessions, two of them waiting with the question shown, plus the pinned strip, unpushed work, and today's digest](docs/screenshots/dashboard-dark.png)

*Every screenshot here is demo data (`CLAUDE_DASH_DEMO=1`). The projects are invented.*

**New in 1.10.0**

- The board says what a waiting session needs: the question, the command awaiting permission, or Claude's last line.
- `Δ n` on every session row, and a changes panel with a diff of every file the session touched.
- Notes on any session, searchable.
- A Plugins & MCP inventory: what is installed, enabled, stale, disabled, or needing auth.
- Agent teams and subagents shown live in Mission Control.
- An idle reminder when a session has waited on you for an hour.

## Try it in one command

```bash
npx claude-mission-control
```

That downloads nothing permanent, starts the server, and opens the dashboard in your browser (add `--no-open` to skip that). Run it again while it's already up and it just opens the tab. Like it? Install it for real below.

Homebrew works too:

```bash
brew tap jonimmswordpressdev/claude-dashboard
brew trust jonimmswordpressdev/claude-dashboard   # newer brew asks once for third-party taps
brew install claude-dashboard
brew services start claude-dashboard   # always-on, starts at login
```

## Install (always-on)

```bash
./install.sh
```

That registers a LaunchAgent (macOS) or a systemd user service (Linux) so the server runs at login and restarts if it dies. Then open <http://127.0.0.1:4517> — in Safari, use **File → Add to Dock** to get a standalone app-like window with its own Dock icon; in Chrome or Edge, use the install-app button in the address bar (the dashboard is a PWA).

Uninstall with `./uninstall.sh`.

On Linux: logs are in `journalctl --user -u claude-dashboard`, notifications use `notify-send`, and sessions open in kitty, Alacritty, GNOME Terminal, Konsole, or xterm — whichever is installed.

## Run manually instead

```bash
node server.js
```

## New to the terminal? Step-by-step install

Five minutes, no experience needed. You type (or paste) each command into the Terminal app and press Return.

1. **Open Terminal.** Press `⌘ Space`, type `terminal`, press Return. A window appears where you can type commands.
2. **Check Node.js.** Type `node --version` and press Return. A number like `v22.1.0` means you're set — anything 18 or higher works. If it says "command not found", install Node from [nodejs.org](https://nodejs.org) (download, run the installer, then close and reopen Terminal and check again). If you already use Claude Code, you almost certainly have it.
3. **Get the code.** Paste this and press Return:

   ```bash
   git clone https://github.com/JonImmsWordpressDev/claude-dashboard.git ~/claude-dashboard
   ```

   That copies the project into a `claude-dashboard` folder in your home folder. No git? Use the green **Code → Download ZIP** button on the GitHub page and unzip it instead.
4. **Move into the folder.** Type `cd ~/claude-dashboard` and press Return.
5. **Install.** Type `./install.sh` and press Return. That's the whole setup — the dashboard now starts itself every time you log in.
6. **Open it.** Go to <http://127.0.0.1:4517> in your browser and bookmark it. In Safari, **File → Add to Dock** turns it into its own app with a Dock icon.
7. **One possible prompt.** The first time, macOS may ask about Keychain access for the usage meters. Click **Always Allow**. That reuses the sign-in Claude Code already has; nothing new to log in to.

You should see a dark board listing your projects. If a Claude Code session is running, it appears as a row at the top — and the status cell turns amber with **needs you** when Claude is waiting for your input.

**Using it day to day** — three things cover most of it:

- **Glance at the top row.** That's what's running right now. Amber **needs you** means go back to that terminal — Claude asked a question.
- **Click any session title** to read the whole conversation. If it's still running, new messages stream in live.
- **Click `open ⬈`** next to an old session to pick it up again — it opens a terminal in the right folder with the conversation restored.

If something looks off, the log is at `~/Library/Logs/claude-dashboard.log`. To remove everything, run `./uninstall.sh` from the same folder.

## What you're looking at

- **Departures** — every live `claude` CLI session as a row on the board: start time, project, current task, model, elapsed time, and a split-flap status cell. The cell flips to an amber **needs you** when a session is waiting on your input — readable from across the room. A second line under the title says what it needs: `?` for a question Claude asked (with its options), `🔒` for a tool call awaiting permission (with the command or file), or the last question in Claude's reply, or failing that the first line of its final paragraph.
- **Mission Control** — the `▦` button in the header (or `⌘K` → Mission Control) tiles every live session side by side, each pane following its own transcript. One screen for "what is everything doing right now".
- **Agents** — a session running subagents or an agent team shows them under its Mission Control pane: name, type, model, and a pulsing `●` while an agent has written in the last two minutes, `○` once it has gone quiet (idle teammates stay alive, so quiet is not finished), with the team name when there is one. Finished sessions list them at the top of the transcript.
- **Pinned** — `☆ pin` on any transcript sticks that session to a strip under the departures board, so the thing you care about stays in view whether it's running or not.
- **Digest** — what happened across every project, grouped by day. Each entry shows the session's recap (Claude's own "away summary" where one exists — click to expand), how many tasks it completed, and an open button. Switch the window between day / 3 days / week; collapses out of the way and remembers your choice.
- **Project cards** — sorted by last activity. Branch chip, `●n` uncommitted changes, `↑n` unpushed commits. The sparkline is prompts per day for the last two weeks. Each session row has an `open ⬈` button that resumes the session in your terminal (new window, right directory) or imports it into the Claude desktop app when it's installed — the **Open in** selector in the header names whichever terminal you've configured (auto-detected on first run). The `⧉` button copies the `claude --resume` command instead.
- **Header meters** — your plan and rate-limit tier (Free/Pro/Max/Enterprise/API, detected from Claude Code's local account cache), live session and weekly usage from Anthropic's usage API via your existing Claude Code sign-in, plus extra-usage spend. Set a **weekly budget** in settings and a third meter tracks estimated spend against it, with one alert each at 75 / 90 / 100%. First run may show one macOS Keychain prompt — click Always Allow.

![Mission Control: every live session tiled side by side, each pane following its own transcript, with the waiting reason at the top of each pane and the agent team under the middle one](docs/screenshots/mission-control.png)

![Transcript viewer live-following a running session: the agent team at the top, then prompts, replies as markdown, and tool calls as one-liners](docs/screenshots/transcript.png)

- **Transcripts** — click any session title (cards, digest, search results, project drawer) to read the conversation: your prompts, Claude's replies rendered as markdown, tool calls as compact one-liners, and away-summaries highlighted. Long sessions show the newest ~1200 events. **Running sessions follow live** — a `● live` badge appears, new turns stream in every few seconds, and the view sticks to the bottom unless you've scrolled up to read.
- **Search** — the header box searches every prompt you've ever sent plus all session titles (Enter to run, 2+ characters). Narrow with `project:name` or `since:7d` / `since:2026-08-01`. Clicking a prompt result opens the transcript scrolled to the matching turn. If the answer isn't in a prompt, **search inside full transcripts** runs the same query across the conversation bodies — slower, so it's a second click rather than the default.
- **Command palette** — `⌘K` from anywhere: fuzzy-jump to any project or session, watch a live session, start a new one, open settings or stats. Arrow keys + Enter.
- **Stats** — click the weekly bar chart in the header: a 26-week activity heatmap, your busiest hours, a weekly-rhythm grid (prompts by day of week and hour), estimated spend per day for the last 90 days, and an all-time per-model token/cost breakdown. The daily spend history is computed from your existing transcripts, so it's full from the first run.
- **Your week with Claude** — a 7-day report (`⌘K`, or the button at the top of stats): sessions, prompts, estimated spend against your budget, busiest day and hour, models used, and how long you typically take to answer a question. Exports as markdown.
- **Day timeline** — `⌘K` → Day timeline: the last 24 hours as one lane per project, with amber ticks where a session needed you.
- **Catch-up** — the `🔔` in the header keeps every notification the server has fired since it started, with an unread count. Useful after a morning away from the desk.
- **Export** — any transcript downloads as clean markdown via the `export ⇩` button.
- **Changes** — a `Δ n` chip on any session row counts the files Claude edited. Click it (or `changes` in the transcript header) for the list with `+added −removed` per file and a unified diff of what the session changed, from the pre-edit backup Claude Code keeps to the file as it is on disk now. Files with several checkpoints also offer each step (`v1 → v2`). Read-only: nothing here reverts anything.

![The changes panel: three files the session touched, the first expanded to a unified diff from the pre-edit backup to disk](docs/screenshots/changes.png)

- **Notes** — `note` in the transcript header attaches a free-text note to a session (⌘⏎ saves, empty removes). Rows with a note show `≡`, hover to read it, and notes are searchable from the header box. Stored in `config.json` under `sessionNotes`.
- **New session** — the `⊕` button on a project card opens a fresh terminal window in that project running `claude`.
- **Cost trend** — the small bar chart in the header is estimated cost per week for the last 8 weeks (hover for numbers). Costs include subagent tokens.
- **Models everywhere** — every session shows which model ran it (live cards, digest, session lists), and the stats view breaks down usage per model and per project.
- **Claude.ai chats** — import the official export from claude.ai (Settings → Privacy → Export data, then feed `conversations.json` to ⚙ settings here) and your chats become browsable (`⌘K` → Claude.ai chats) and full-text searchable next to your coding sessions. Stored slimmed in your local config dir, gitignored, never uploaded anywhere.

![Stats view: activity heatmap, busiest hours, weekly rhythm, 90-day spend, and per-model cost breakdowns](docs/screenshots/stats.png)

- **Project details** — click any project's name for a slide-over with its full session list, recent git commits, rendered CLAUDE.md, per-project memory files, skills/agents/commands from `.claude/`, and settings (permissions, MCP servers, allowed tools). Read-only; also a quick audit of which projects are missing instructions or memory. Esc closes.
- **Plugins & MCP** — `⌘K` → Plugins & MCP (or the button in settings) lists every installed plugin with its marketplace, version, on/off state and a `stale` flag when its marketplace was refreshed after the plugin was last updated, plus every MCP server with its scope, the projects that use it, an `off` chip for servers you have disabled in a project, and an amber `needs auth` when Claude Code says so. Read-only; server secrets never reach the browser.

![Plugins & MCP inventory: plugins with on, off, stale and missing states; MCP servers with scope, projects, disabled flags and needs-auth](docs/screenshots/inventory.png)

- **Unpushed work strip** — an amber band listing every repo with uncommitted changes (`●n`) or unpushed commits (`↑n`), sorted by recent activity. Disappears when everything's clean.
- **Dormant** — projects with no activity for 60+ days, tucked away at the bottom.
- Worktree sessions (`.claude/worktrees/…`) are folded into their parent project and badged `⎇`.
- **Notifications** — the moment any session flips to "waiting for input", you get a macOS notification (with sound) naming the project and what it needs — the question, the command awaiting permission, or Claude's last line. Fires once per wait, never on server restart. Mute a single noisy project from its slide-over (the bell button at the top), or disable everything with `CLAUDE_DASH_NOTIFY=0` in the plist. Notifications arrive via Script Editor/osascript — if you don't see them, allow it under System Settings → Notifications.
- **Cost estimates** — the header shows the estimated list-price value of the last 7 days across all projects; each project card and digest entry shows its share. Computed from token usage in the transcripts at Anthropic list rates (cache reads at 0.1×, cache writes at 1.25×). On a subscription plan these are relative weights, not billed dollars — use them to see where your usage goes. Subagent tokens are included.
- **Stuck flag** — a session that's "busy" but has written nothing to its transcript for 10+ minutes gets an amber `quiet Nm` cell; at 20 minutes you get one notification. It's a hint, not a verdict — a session waiting on slow background work can look the same.
- **Idle reminder** — a session left on **needs you** for an hour (configurable in settings, `0` to turn off) gets one more notification and a `still waiting` entry in the catch-up bell, and its elapsed cell turns amber with the wait time. Nothing repeats until you answer it.

![Light mode — the same board, printed on paper](docs/screenshots/dashboard-light.png)

## Menu bar companion

A SwiftBar plugin lives in `menubar/claude-dash.15s.sh`. The menu bar shows `❯ N` while sessions run, `❯ N⚠` in amber when one is waiting on you, and `❯ N?` when a busy session has gone quiet, and `❯ N⚠⏳` when one of them has waited past the idle reminder. The dropdown lists live sessions, repos with unpushed work, the 7-day estimate, and an "Open dashboard" link.

Setup: `brew install --cask swiftbar`, then point SwiftBar's plugin folder at this repo's `menubar/` directory. The plugin refreshes every 15 seconds (rename the file to change the interval).

## Settings

The ⚙ gear in the header opens settings — no JSON editing required:

- **Notifications** on/off (writes `config.json`); per-project mute lives on each project's slide-over
- **Terminal** for open/new-session buttons: Ghostty, iTerm2, or Terminal.app, auto-detected (`config.json`)
- **Claude desktop app**: lets `open ⬈` hand a session to the Claude app instead of a terminal
- **Usage meters** on/off — this is the switch for the one automatic network call
- **Theme**: Departures board (follows system light/dark), Phosphor, Amber CRT, Midnight, or Newsprint (`config.json`)
- **Weekly budget** in dollars — drives the header meter and the 75 / 90 / 100% alerts; `0` turns it off
- **Idle reminder** in minutes — one extra notification when a session has waited that long; `0` turns it off
- **Rename any project** (writes `names.json`) or **hide it** and its whole subtree (writes `ignore.json`), with an unhide list below
- **Claude.ai chats**: pick the `conversations.json` from your claude.ai export to make those chats searchable here
- **Updates**: "check for updates" asks GitHub only when you click; when a new release is out, **update now** pulls it in place (git or npm installs) and service installs restart themselves on the new version

Everything saves instantly; the underlying files stay hand-editable. Keyboard: `⌘K` for the palette, `/` for search, `Esc` closes anything.

## Getting started with config

`names.json`, `ignore.json`, and `config.json` are your local files (gitignored). Copy the `.example` versions to start, or just use the ⚙ settings panel — it creates them for you.

## Friendly names

Edit `names.json` to control how projects are titled:

```json
{ "/Users/you/Local Sites/north-ave": "North Avenue" }
```

Unlisted projects fall back to a cleaned-up folder name. Changes are picked up automatically — no restart needed.

Sessions can be renamed too: click the ✎ next to any session title (live board, project cards, pinned strip, or a project's slide-over), type a name, and press Enter. Escape cancels; an empty name goes back to the automatic title. Custom names live in `config.json` under `sessionNames`, keyed by session id, and win over the AI-generated or first-prompt title everywhere.
Notes work the same way: `sessionNotes` in `config.json`, keyed by session id, editable by hand.

## Hiding projects

Edit `ignore.json` — an array of absolute path prefixes. A project is hidden if its path is, or sits under, any listed prefix, so one line hides a whole tree (e.g. all the plugins/themes inside one site). This only hides them from the dashboard, strip, and menu bar; nothing on disk or in `~/.claude` is touched. Picked up automatically.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_DASH_PORT` | `4517` | Port (change it in the plist too) |
| `CLAUDE_DASH_DEV` | unset | `1` = re-read index.html on every request |
| `CLAUDE_DASH_NOTIFY` | unset | `0` = disable macOS notifications |
| `CLAUDE_DASH_HOST` | `127.0.0.1` | Bind address — see below before changing |
| `CLAUDE_DASH_DEMO` | unset | `1` = serve believable fake data (screenshots, trying it without Claude history) |
| `CLAUDE_DASH_OPEN` | unset | `1` = open the browser on startup (what `npx` sets for you) |
| `CLAUDE_DASH_CONFIG_DIR` | repo dir | Where config.json/names.json/ignore.json live (auto-falls back to `~/.config/claude-dashboard`) |

The server binds to `127.0.0.1` only by default.

## Windows (experimental — testers wanted)

The core is plain cross-platform Node, and Windows support is wired in: paths handle drive letters, notifications use native toasts, and sessions open in Windows Terminal, PowerShell, or cmd (auto-detected). Install from PowerShell in the repo folder:

```powershell
.\install.ps1
```

That registers a logon Scheduled Task ("ClaudeDashboard") running the server hidden. Remove it with `.\uninstall.ps1`. The SwiftBar menu bar companion is macOS-only.

**Honest label: this is untested on real Windows** — it was written carefully on a Mac. If you run it on Windows, please [open an issue](https://github.com/JonImmsWordpressDev/claude-dashboard/issues) with what worked and what didn't; the first Windows tester shapes this.

## Access from your phone

The recommended path is [Tailscale](https://tailscale.com): install it on the Mac and your phone, then run `tailscale serve --bg 4517`. That publishes the dashboard over HTTPS inside your private tailnet while the server itself stays loopback-only — nothing is exposed to the internet or your LAN. Alternatively set `CLAUDE_DASH_HOST=0.0.0.0` in the plist to bind to all interfaces, but understand what that means: anyone on the same network can view the dashboard **and use the open/new-session endpoints, which launch terminal commands on this Mac**. Don't do that on a network you don't fully control.

## Maintenance

- Logs: `~/Library/Logs/claude-dashboard.log`
- Restart after pulling changes: `launchctl kickstart -k gui/$(id -u)/com.claude-dashboard`
- Tests: `node --test test/pure-logic.test.js`

## Demo mode

```bash
CLAUDE_DASH_DEMO=1 node server.js
```

Every `/api/*` route serves invented data from `lib/demo.js` instead of reading `~/.claude` — two live sessions, a handful of projects, a full transcript. Nothing touches your own history, so it's the safe way to try the UI, record a walkthrough, or take screenshots. Every image in this README comes from it. Edit `lib/demo.js` if you want different fixtures.

## Data sources

| What | Where |
|---|---|
| Live sessions | `~/.claude/sessions/<pid>.json` (liveness re-checked against the pid) |
| Project registry | `~/.claude.json` `projects` map |
| Session titles | `~/.claude/projects/**/**.jsonl` (`ai-title` records, head/tail scan only — never full parses) |
| Activity | `~/.claude/history.jsonl` |
| Session todos | `~/.claude/tasks/<sessionId>/` |
| Usage meters | Anthropic usage API via Claude Code's Keychain sign-in (fallback: `~/.claude/.statusline-usage-cache`) |

## Credits

Built by [Jon Imms](https://jonimms.com) — WordPress and Gutenberg developer writing about AI-assisted development — pair-programmed with [Claude Code](https://claude.com/claude-code). The story of how it was built is in [the launch post](https://jonimms.com/blog/claude-code-dashboard/). MIT licensed; issues and PRs welcome.
