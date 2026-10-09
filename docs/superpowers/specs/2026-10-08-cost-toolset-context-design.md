# Cost, toolset, and context pressure — design

Date: 2026-10-08. Three independent sections (A, B, C); each ships on its
own. Shared constraint for all three: the dashboard stays **read-only**.
Nothing here writes to `~/.claude`, `~/.claude.json`, or any project's
`.claude/` directory. The only writes remain the existing `config.json`
family. No new network calls. No npm dependencies.

Decided in brainstorming (2026-10-08): option 1 of three — show the
effective toolset per project, offer copyable recipes and an "open file"
button, never toggle anything ourselves. Target is public adoption (the
package ships on npm and Homebrew), so wording and defaults must hold for
users on API billing, Pro/Max, and Team/Enterprise alike.

Facts this design relies on (checked against the Claude Code docs on
2026-10-08, with doc URLs in the brainstorming transcript):

- `enabledPlugins` is honoured in `~/.claude/settings.json`, the project's
  `.claude/settings.json`, and `.claude/settings.local.json`. Precedence,
  highest first: managed, `--settings`, local, project, user. A key set at
  a higher level overrides the same key lower down.
- Subagents are disabled per scope with `permissions.deny: ["Agent(name)"]`
  (`Task(name)` is a legacy alias). Same-name agents resolve
  `.claude/agents/` > `~/.claude/agents/` > plugin `agents/`.
- Skills are controlled per scope with `skillOverrides: { name: "on" |
  "name-only" | "user-invocable-only" | "off" }` (the `/skills` menu writes
  this to `.claude/settings.local.json`). Plugin skills are not affected by
  `skillOverrides`; they follow the plugin's enabled state. `Skill(name)`
  deny rules also exist.
- MCP per-project on/off (`disabledMcpServers`, `enabledMcpServers`) lives
  only in `~/.claude.json`. `.mcp.json` servers can additionally be vetoed
  with `disabledMcpjsonServers` in any settings file.
- No local file records billed dollars or whether a session was billed to
  API or subscription. Claude Code's own `/usage` dollar figure is a
  list-price estimate computed from token counts, the same thing we do.
- Context windows: every Claude 5.x model and Opus/Sonnet 4.6+ is 1M
  tokens; Haiku 4.5 and older models are 200K. Verified empirically: a
  local Sonnet 5.5 transcript carries 607K cache-read tokens on its last
  turn, so 200K is not a safe assumption.

---

## A. Honest, visible cost everywhere

### A0. Rate table refresh (prerequisite)

`lib/pricing.js` `RATES` is stale against the 2026-10-06 list prices.
Replace with (USD per MTok; `cacheRead` given only where it is not the
default 0.1× input):

| prefix | input | output | cacheRead |
|---|---|---|---|
| `claude-fable-5` (covers 5 and 5-1) | 10 | 50 | 0.25 |
| `claude-mythos` | 10 | 50 | 0.25 |
| `claude-opus-5-5` | 4 | 20 | 0.20 |
| `claude-opus-5` | 5 | 25 | |
| `claude-opus-4-1`, `claude-opus-4-0`, `claude-opus-4-2025` | 15 | 75 | |
| `claude-opus` (4-5 … 4-8) | 5 | 25 | |
| `claude-sonnet-5` (covers 5 and 5-5) | 2 | 10 | |
| `claude-sonnet-4-6`, `claude-sonnet` (older) | 3 | 15 | |
| `claude-haiku-5-5` | 0.10 | 0.50 | |
| `claude-haiku-4`, `claude-3-5-haiku`, `claude-haiku` | 1 / 0.8 / 1 | 5 / 4 / 5 | |

Order matters: more specific prefixes first. Cache write stays 1.25×
input. Haiku 5.5's >100K-prompt tier ($0.50 / $2.50) is ignored; note it in
the file comment. Bare aliases seen in transcripts (`sonnet`, `opus`,
`haiku`) map to the current generation of that family. `estimateCost` reads
`r.cacheRead` when present, else `r.input * 0.1`. Update the comment's
"rates cached" date. Tests: one assertion per new row plus the alias
mapping and the cacheRead override.

### A0b. Keeping rates current without a network call

There is no Anthropic pricing endpoint (the Models API returns context
windows and capabilities, not prices), and Claude Code itself ships a
bundled table that it does not fetch from the Console. So the bundled table
stays the baseline and is refreshed through ordinary releases via the
existing update path. Three read-only measures stop it going silently
stale:

**1. Honour Claude Code's `modelPricing` managed setting.** Documented
shape (settings reference, "Model and responses"; requires Claude Code
v2.1.242, markups v2.1.271):

```json
{
  "modelPricing": {
    "multiplier": 0.85,
    "overrides": {
      "claude-sonnet-4-6": { "input": 2.4, "output": 12, "cacheRead": 0.24, "cacheWrite": 3 }
    }
  }
}
```

- `multiplier`: number, > 0 and <= 10, scales every cost whether or not an
  override row matches.
- `overrides`: map from model id to `{ input, output, cacheRead,
  cacheWrite }`, each 0..10000, USD per million tokens. `cacheWrite` is an
  absolute rate (not a multiple of input), so a matched row bypasses our
  1.25× rule. A row keyed by a built-in model id applies to every dated
  snapshot and provider-specific id of that model; any other key applies
  to that exact id only, and an exact match wins over a built-in-id match.
- Claude Code reads it from managed settings only and ignores it in user,
  project, and local settings. We mirror that: read
  `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
  `/etc/claude-code/managed-settings.json` on Linux, and
  `C:\\Program Files\\ClaudeCode\\managed-settings.json` on Windows
  (paths from the managed-settings docs; put them in `lib/paths.js`). Server-
  managed and MDM-delivered settings are not readable from disk and are out
  of scope; the diagnostics line (3 below) says "managed pricing: file" or
  "none found" so the user knows which case they are in.

**2. The same shape in our own `config.json`.** Key `modelPricing`, same
fields, same validation. Individuals have no managed settings, and this is
the file we already own and hand-edit. Precedence: managed file (if any)
first, then `config.json`, then the bundled table. A `multiplier` in both
is not combined; the higher-precedence source wins whole. Not editable
from the settings UI (hand-edit only, like `sessionNotes` used to be);
the settings view shows the active source and a "copy skeleton" button
that puts a commented example on the clipboard.

**3. Unpriced-model flag.** `rateFor(model)` returns `{ ...rate,
assumed: true }` when the id fell through to `DEFAULT_RATE`. `estimateCost`
gains an optional second return via a new `costReport(usageByModel)` that
returns `{ usd, assumedModels: [...] }`; existing callers of `estimateCost`
are unchanged. Session metas carry `assumedModels` (the collector adds it
to session rows, live sessions, and the A2 breakdown). UI: the cost badge
gets a `?` suffix and tooltip "Rate for <model> is not in this version's
table; Opus-tier rate assumed. Update the dashboard or set modelPricing."
Settings diagnostics lists the distinct unpriced model ids seen across all
transcripts, and the active pricing source.

Implementation: `lib/pricing.js` exports `loadPricing({ managed, config })
-> { multiplier, overrides, source }` (pure; the file reads happen in
`lib/config.js`, fresh-by-mtime like the other config files) and
`rateFor(model, pricing)`. The collector passes the loaded pricing into
every `estimateCost` call site; `pricing` is re-read on each `assemble()`
by mtime so a hand-edit shows on the next poll. Tests: multiplier only;
override only; override wins over bundled and `cacheWrite` is absolute;
built-in id matches a dated snapshot id; exact key beats built-in match;
out-of-range values dropped row-by-row, rest kept; `assumed` set for an
unknown id and cleared when an override covers it.

### A1. Running cost on live sessions

`collector.assemble()` already builds `modelBySession` from transcript
metas; add `usageBySession` the same way (value: `combinedUsage(m)`, so
subagent tokens are included, matching every other cost figure). Each entry
in `liveSessions` gains:

```
estCost:  number | null   // USD, rounded to cents
burnRate: number | null   // USD per hour, whole dollars; null under $1/h and
                          // for the first 5 minutes (startedAt from the
                          // session file), so a one-turn session doesn't
                          // read as $400/h
```

Whole dollars rather than cents: a cents figure drifts with the clock and would change the state fingerprint on every poll for an idle session, which the stable-state rule forbids.

Both are rounded before entering state so the SSE fingerprint only changes
when a displayed digit would. `burnRate = estCost / hoursSince(startedAt)`.
Pure helper `burnRate(usd, startedAt, now)` in `lib/pricing.js`, tested
(under 5 min → null; 30 min at $1 → 2.00).

UI: the departures board row gets a cost cell after the model cell:
`≈$1.84` with `$3.70/h` beneath in the faint style used for elapsed time.
Mission Control pane heads show `≈$1.84 · $3.70/h` in `.mc-meta`. Demo mode
(`lib/demo.js`) fills both fields.

### A2. Cost breakdown in the transcript viewer

`GET /api/session` (initial load only, i.e. `after` is 0) adds:

```
usage: {
  cost: 1.84,                       // total incl. subagents
  tokens: 1234567,                  // total incl. subagents
  cacheHitRatio: 0.94,              // see A3; null when no input tokens
  byModel: [                        // sorted by cost desc
    { model, input, output, cacheRead, cacheCreation, cost }
  ],
  subagents: { count: 3, cost: 0.41, tokens: 410000 } | null,
  context: { tokens, window, pct } | null,   // C1, same object
  tools: { total, errors, byName: [{ name, count, errors }] } | null  // C2
}
```

Built by a pure `usageBreakdown(meta)` in `lib/transcripts.js` from the
meta the collector already holds. `collector.findSessionFile(id)` has the
meta in hand (it iterates `transcriptGroups`) but returns only derived
fields; add `usage: usageBreakdown(m)` to its return value so the endpoint
never re-reads the file. Tested against a hand-built meta with two models
and subagent usage.

UI: the transcript header gains a `≈$1.84 ▾` badge next to the model. Click
toggles an inline panel (same `.stat-table` style as stats): one row per
model with the four token columns and cost, a subagent row when present,
and a footer line `cache 94% · context 412k / 1M (41%) · 142 tool calls, 3
failed`. Live-following sessions refresh the badge from the `liveSessions`
state (A1) between full reloads; the panel refreshes on the next initial
load only. Not shown while `usage` is absent (session with no assistant
turns yet).

### A3. Cache efficiency

`cacheHitRatio = cacheRead / (input + cacheRead + cacheCreation)` over the
session's combined usage; null when the denominator is 0. Pure
`cacheHitRatio(usageByModel)` in `lib/pricing.js`, tested. Surfaced in the
A2 panel and as one line in the week report ("Cache hit rate: 91% across
this week's sessions" — token-weighted, from the same metas
`statsSummary` already walks). Nothing on cards; this is a diagnostic, not
a headline.

### A4. Plan-aware wording

One client-side helper, `costWording()`, reads `state.plan.billing`:

| condition | noun | tooltip |
|---|---|---|
| `billing === 'api'` | estimated cost | Estimated from token counts at Anthropic list prices. Your invoice is the source of truth. |
| anything else | list-price value | What these tokens would cost at API list price. On a subscription this is a relative weight, not a bill. |

Every cost tooltip in `index.html` (header 7d chip, project card 7d badge,
session-row chip, digest chip, stats totals, week report, A1 cells, A2
badge) uses it. The `≈` prefix stays in both cases. No server change:
`plan.billing` is already in state.

### A5. Most expensive sessions

`statsSummary()` adds `topSessions`: the 10 highest-cost sessions all time,
`{ sessionId, title, projectName, projectPath, model, cost, lastActivityAt
}`. `title` via `sessionTitle(m, sessionNames)` so renamed sessions show
their names. Stats view gets a section "Most expensive sessions" as a
`.stat-table`: title (click opens the transcript), project, model, cost,
when. Demo fixture included.

### Out of scope for A

Per-turn cost inside the transcript (would need a full parse or a new
streaming accumulator keyed by turn; revisit if asked). Any attempt to
infer "real" billed dollars.

---

## B. Project toolset view, read-only

### B1. Module `lib/toolset.js`

```
readToolset(projectRoot, inventory) -> {
  plugins: Row[], agents: Row[], skills: Row[], mcp: Row[],
  audit: Finding[],
  files: { user: bool, project: bool, local: bool }   // which settings files exist
}
```

`Row`:

```
{
  name,                     // display name (plugin id, agent name, skill name, server name)
  enabled: bool,
  source: 'user' | 'project' | 'local' | 'plugin' | 'global' | 'mcp.json',
  pluginId: string | null,  // for agents/skills that come from a plugin
  decidedBy: 'managed' | 'local' | 'project' | 'user' | 'plugin' | 'default' | 'claude.json',
  shadowed: string[],       // other sources defining the same name, lower precedence
  description: string | null,
  recipe: { label, text }   // what to copy to flip it; see B2
}
```

Inputs, all read-only and each read fresh (the view is on-demand, not
polled):

| what | where |
|---|---|
| user settings | `~/.claude/settings.json` |
| project settings | `<root>/.claude/settings.json` |
| local settings | `<root>/.claude/settings.local.json` |
| installed plugins + enabled map + marketplaces | the `inventory` object already produced by `lib/inventory.js` (passed in, not re-read) |
| plugin contents | `installPath` from `installed_plugins.json` (present in the file today; fall back to `~/.claude/plugins/cache/<marketplace>/<name>/<version>`): `agents/*.md`, `skills/*/SKILL.md` |
| user agents / skills | `~/.claude/agents/*.md`, `~/.claude/skills/*/SKILL.md` |
| project agents / skills | `<root>/.claude/agents/*.md`, `<root>/.claude/skills/*/SKILL.md` (same readers `lib/detail.js` uses; lift `listMd` / `frontmatterDescription` into a shared helper rather than duplicating) |
| MCP | `inventory.mcp` rows filtered to `scope === 'global'` or `projects` containing this root; `enabled = !disabledIn.includes(root)` |

Managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json`
on macOS) are read if present and treated as highest precedence; absent on
most machines.

Resolution, as pure exported functions so tests can hit them without a
filesystem:

- `resolvePlugins(installed, scopes)` — `scopes` is `{ managed, local,
  project, user }` each `{ enabledPlugins }` or null. For each plugin id,
  the highest scope that mentions it decides; `decidedBy` names it;
  unmentioned installed plugins are `enabled: false, decidedBy: 'default'`.
- `resolveAgents(candidates, scopes)` — `candidates` are `{ name, source,
  pluginId, description }` from project, user, and enabled plugins (an
  agent from a disabled plugin is not a candidate). Same-name collapse:
  project > user > plugin; losers go in `shadowed`. Then any
  `permissions.deny` entry `Agent(name)` or `Task(name)` in any scope sets
  `enabled: false, decidedBy: <that scope>`. Deny wins over allow, matching
  the permissions docs.
- `resolveSkills(candidates, scopes)` — project and user skills: look up
  `skillOverrides[name]` highest scope first; `"off"` → disabled,
  `"name-only"` / `"user-invocable-only"` → enabled with `mode` set, absent
  → enabled/default. Then `Skill(name)` deny rules as for agents. Plugin
  skills: `enabled` follows the plugin row; `decidedBy: 'plugin'`.
- `auditToolset(rows, inventory)` → findings `{ level: 'warn' | 'info',
  text }`:
  - deny rule names an agent/skill that no source defines
  - plugin in `enabledPlugins` (any scope) but not installed
  - enabled plugin flagged `stale` by the inventory
  - MCP server used by this project with `needsAuth`
  - same-name agent defined in two sources (informational: says which won)

### B2. Recipes

Each row's `recipe.text` is what the user copies to flip that row, aimed at
`.claude/settings.local.json` because it is the highest-precedence file the
user owns and is gitignored by convention. Plugin:
`{"enabledPlugins": {"<id>": false}}` (or `true`). Agent:
`{"permissions": {"deny": ["Agent(<name>)"]}}`; to re-enable, the recipe
says which file holds the deny rule to remove. Skill:
`{"skillOverrides": {"<name>": "off"}}`. MCP: the recipe is a sentence, not
JSON — `Run /mcp inside a Claude session in this project and toggle
<name>` — because the state lives in `~/.claude.json`, which we do not
write and should not teach users to hand-edit. `.mcp.json` servers get a
second recipe: `{"disabledMcpjsonServers": ["<name>"]}`.

The UI copies `text` to the clipboard and shows a one-line toast naming
the target file. Merging into an existing file is the user's job; the
toast says "merge into `.claude/settings.local.json`" rather than
implying the snippet replaces the file.

### B3. Endpoint and opener

`GET /api/project` (existing, path already validated against
`collector.projectPaths()`) adds `toolset` from `readToolset(known,
inventory)`. The collector does not hold an inventory; `/api/inventory`
calls `readInventory(collector.projectPaths())` per request. Do the same
here: add `readInventory(...)` to the endpoint's existing `Promise.all`
(four small JSON reads plus one `.mcp.json` stat per known project, same
as the Plugins & MCP view already pays). Demo mode serves a fixture
toolset alongside `demoInventory()`.

`POST /api/reveal-file` body `{ path, which }` with `which` in
`'local' | 'project' | 'mcpJson'`. Server resolves `path` against
`collector.projectPaths()` (reject otherwise), maps `which` to the fixed
relative file (`.claude/settings.local.json`, `.claude/settings.json`,
`.mcp.json`), checks the file exists (404 otherwise; never creates it),
then calls `revealFile(abs)` in `lib/opener.js`: macOS `open -R`, Linux
`xdg-open` on the directory, Windows `explorer /select,`. Same-origin
enforced like the other POSTs. The client never sends a filesystem path
beyond the known project root.

### B4. UI

New section in the project slide-over, after "Skills, agents & commands":
**Toolset — n on · m off**, with four sub-tables (Plugins, Agents, Skills,
MCP servers). Columns: name (with description on hover), state chip (`on` /
`off` / `name-only` / `user-only`), source chip (`user` / `project` / `local`
/ `plugin:<name>` / `global` / `.mcp.json`), and a `⧉` copy button. Rows
with `shadowed` show a `shadows n` hint. Findings from `audit` render as an
amber list at the top of the section. Buttons at the section foot: `open
settings.local.json`, `open settings.json`, `open .mcp.json`, each only when
the file exists; otherwise the button is replaced by `create
settings.local.json` text that copies an empty `{}`-with-recipe skeleton.

The existing "Skills, agents & commands" section stays (it shows file
contents; the toolset shows resolution). Plugins & MCP view links to the
project slide-over are unchanged.

### Scope cut, stated

A per-project audit chip on the project cards was promised in
brainstorming. It needs the toolset resolved inside the polled `scan` loop
for every project, which adds per-project directory reads to the hot path.
Deferred: the audit lives in the slide-over only for this round. If wanted
later, the cheap subset (plugin enabled-but-missing, stale, MCP needs auth)
can be derived from the inventory alone without touching project dirs.

---

## C. Context pressure and tool activity

### C1. Context window fill

`scanLine` already parses every assistant record with `usage`. Record on
the scan state:

```
scan.lastContext = {
  tokens: input + cacheRead + cacheCreation of this message,   // the prompt size Claude just saw
  model,
  at: timestamp ms
}
```

Latest assistant message wins (the existing message-id dedupe applies).
Main-loop transcript only; subagents have their own contexts and are not
merged. `meta.context = scan.lastContext`. Persisted on the cached scan
state like `usage`, so it survives incremental rescans.

`lib/pricing.js` gains `contextWindow(model)`: 1,000,000 for ids matching
`claude-fable-5`, `claude-mythos`, `claude-opus-5`, `claude-opus-4-[678]`,
`claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-5`, and the bare
aliases `opus` / `sonnet` / `haiku`; 200,000 otherwise (Haiku 4.5, older
models, unknown). Tested.

`liveSessions[]` gains `context: { tokens, window, pct } | null` with
`tokens` rounded to the nearest 1,000 and `pct` to a whole number so the
fingerprint stays quiet. The same object goes into `/api/session`'s
`usage.context` (A2).

UI: a thin meter under the model cell on the departures board and in the
Mission Control pane head: `412k / 1M` label, bar fill = pct, default
colour below 70%, `--warn` amber from 70%, red from 90%. Tooltip: "How much
of the context window the last turn used. Claude Code compacts
automatically as this fills; a fresh session is cheaper per turn when it is
high." Demo mode fills it.

### C2. Tool activity per session

In the same assistant-record parse, walk `message.content` for
`tool_use` blocks and count by `name` into `scan.tools = { [name]: { count,
errors } }`. Remember the last 256 `tool_use.id → name` pairs in
`scan.toolIds` (a plain array used as a ring; oldest dropped) so results can
be attributed. Add a `scanLine` branch for user records containing
`"tool_use_id"` and `"is_error":true`: parse, and for each `tool_result`
with `is_error`, look up the name and bump `errors`; unknown ids count under
`"(unknown)"`. The existing user-record branch for prompts is untouched
(it already excludes `tool_use_id` lines).

Exposed as `usage.tools` in `/api/session` (A2: `{ total, errors, byName }`
sorted by count desc, top 12) and as `tools: { total, errors }` on
`liveSessions[]` for a Mission Control meta `142 tools · 3 failed` (the
`failed` part only when > 0, in `--warn`). Subagent transcripts are not
counted (their tools are their own; the agents list already shows them).

Cost: one extra array walk per assistant record and one JSON parse per
error result, both only on bytes appended since the last scan. No change to
the head/tail/incremental structure; the no-full-parse property holds.

---

## Testing

All new pure functions exported and covered in
`test/pure-logic.test.js` with `node:test`:

- pricing: new rates, alias mapping, `cacheRead` override, `burnRate`,
  `cacheHitRatio`, `contextWindow`
- transcripts: `scanLine` with an assistant record (context captured, tools
  counted), a second record with the same message id (ignored), an
  `is_error` tool result (error attributed by id; unknown id bucket),
  `usageBreakdown` on a two-model meta with subagents
- toolset: `resolvePlugins` (local overrides user; unmentioned installed →
  off/default), `resolveAgents` (project shadows user shadows plugin; deny
  in any scope wins; `Task(` alias; disabled plugin's agents absent),
  `resolveSkills` (override values; plugin skills follow plugin), `auditToolset`
  (each finding type once)
- collector: `topSessions` ordering and cap via `statsSummary` on a
  fixture if the existing tests already stub metas; otherwise unit-test the
  extracted sort helper

Manual smoke test on port 4599 against real data (see memory: 4517 is the
LaunchAgent): a live session shows cost, burn rate, and context meter; the
transcript panel totals equal the session-row chip; the project slide-over
toolset for this repo lists the superpowers and ecc plugins with the right
state; `open settings.local.json` reveals the file in Finder.

## Ordering

A0 → A0b → A1 → A2 (+C1/C2 fields can land as null first) → A3 → A4 → A5, then
B1 → B2 → B3 → B4, then C1 → C2. A4 is UI-only and can be done any time
after A1. README "What you're looking at" gets one bullet per shipped
batch; the "Cost estimates" bullet is rewritten to describe the plan-aware
wording.
