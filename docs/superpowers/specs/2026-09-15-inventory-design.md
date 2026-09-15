# Plugin and MCP inventory — design

Date: 2026-09-15. Feature 9 of the September 2026 batch.

## Behaviour

One on-demand view listing every installed plugin and every configured MCP
server across all known projects. Reached from `⌘K → Plugins & MCP` and a
link in settings. Read-only.

## Sources (all read-only)

| source | gives |
|---|---|
| `~/.claude/plugins/installed_plugins.json` | plugin id, marketplace, version, installedAt, lastUpdated, scope |
| `~/.claude/settings.json` → `enabledPlugins` | enabled / disabled per plugin id |
| `~/.claude/plugins/known_marketplaces.json` | marketplace name, source repo, lastUpdated |
| `~/.claude.json` → `mcpServers` and `projects[*].mcpServers` | global and per-project MCP servers (name, transport/command) |
| `<project>/.mcp.json` for each collector-known project | project-shared MCP servers |
| `~/.claude/mcp-needs-auth-cache.json` | servers currently flagged as needing auth |

## Module (`lib/inventory.js`)

```
readInventory(projectPaths) -> { plugins: [...], marketplaces: [...], mcp: [...] }
```

Pure helpers, exported for tests:

- `mergePlugins(installed, enabledMap, marketplaces)` → rows `{ id, name, marketplace, version, installedAt, lastUpdated, enabled, stale }`. `stale` is true when the marketplace's `lastUpdated` is newer than the plugin's `lastUpdated` by more than a day. Plugins present in `enabledPlugins` but not installed are listed with `installed: false`.
- `mergeMcp(globalServers, projectServers, mcpJsonByProject, needsAuth)` → rows `{ name, scope: 'global'|'project'|'mcp.json', projects: [...], transport, needsAuth }`, one row per distinct name+scope.

Secrets: `env` blocks and `headers` in server definitions are never returned.
Only `command`/`url`/`type` are surfaced.

## Endpoint

`GET /api/inventory` → the object above. Not polled; computed on request.
Demo mode serves a fixture.

## UI

Full-width view like Stats. Two tables:

1. **Plugins** — name, marketplace, version, updated (relative), state chip
   (`on` / `off` / `stale`). Disabled plugins collapse under a "show n
   disabled" toggle.
2. **MCP servers** — name, scope, projects using it (friendly names,
   clickable to the project slide-over), transport, and an amber `needs
   auth` chip.

Header summary line: `n plugins (m enabled) · k MCP servers · j need auth`.

## Tests

`mergePlugins`: enabled/disabled, stale vs fresh, enabled-but-missing.
`mergeMcp`: global + project union, same name in two projects merges, auth
flag, secrets stripped.

## Out of scope

Enabling, disabling, or updating plugins from the dashboard.
