# opencode-mcp-watchdog

[![npm version](https://img.shields.io/npm/v/@mrcarb0n/opencode-mcp-watchdog.svg)](https://www.npmjs.com/package/@mrcarb0n/opencode-mcp-watchdog)

Opencode plugin: on every startup it checks all configured MCP servers via
opencode's own API, reconnects the failed ones, and shows a TUI toast summary.
No sidecar processes — opencode core keeps owning MCP lifecycles.

## Install

Via config (npm):

```json
{ "plugin": ["@mrcarb0n/opencode-mcp-watchdog"] }
```

Restart opencode — Bun installs it automatically. ~8s after launch you get a toast like:

```
MCP watchdog (startup)
14/15 connected · failed: github (spawn npx ENOENT…) · disabled: git
```

Local alternative:

```bash
cp index.js ~/.config/opencode/plugins/mcp-watchdog.js
```

## Tool

`mcp_watchdog` with one arg:

- `status` — list every server with state (`✓ connected`, `✗ failed`, `○ disabled`, `⚠ needs_auth`)
- `reconnect` — reconnect failed servers in parallel now, report what recovered plus the reason for each still-failing server

## Triggers

| Trigger | Behavior |
|---|---|
| Startup (+8s) | check + heal + toast |
| `server.connected` | check + heal + toast (15s cooldown from run end; concurrent triggers share one run) |
| `session.error` | silent heal, toasts only if something recovered/failed |

Servers reporting `needs_auth` / `needs_client_registration` are listed, never
retried. Outside the TUI (`serve`/`web`/headless) the toast is skipped and the
tool keeps working.
