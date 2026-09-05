# opencode-mcp-watchdog

Opencode plugin: on every startup it checks all configured MCP servers via
opencode's own API, reconnects the failed ones, and shows a TUI toast summary.
No sidecar processes — opencode core keeps owning MCP lifecycles.

## Install

Local (works today):

```bash
cp index.js ~/.config/opencode/plugins/mcp-watchdog.js
```

Restart opencode. ~8s after launch you get a toast like:

```
MCP watchdog (startup) — 14/15 connected · disabled: git
```

Via config (once this repo is public on npm):

```json
{ "plugin": ["opencode-mcp-watchdog"] }
```

## Tool

`mcp_watchdog` with one arg:

- `status` — list every server with state (`✓ connected`, `✗ failed`, `○ disabled`, `⚠ needs_auth`)
- `reconnect` — reconnect failed servers now, report what recovered

## Triggers

| Trigger | Behavior |
|---|---|
| Startup (+8s) | check + heal + toast |
| `server.connected` | check + heal + toast (15s dedup guard) |
| `session.error` | silent heal, toasts only if something recovered/failed |

Servers reporting `needs_auth` / `needs_client_registration` are listed, never
retried. Outside the TUI (`serve`/`web`/headless) the toast is skipped and the
tool keeps working.
