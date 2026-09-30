# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0]

### Added

- Dual v1/v2 entrypoint: default export is now
  `{ id: "opencode-mcp-watchdog", server, setup }`. v1 runtimes use `server`,
  v2 runtimes (`opencode` 2.x) use `setup`; each ignores the other's key.
- `prepare` script so Git-spec installs (`github:MrCarb0n/opencode-mcp-watchdog`)
  self-build `dist/`.

### Changed

- v2 heal path is config `reload()` (the v2 server-plugin sandbox exposes
  `mcp.list()` but no per-server `connect()`); summaries go to the server log
  instead of TUI toasts, which server plugins cannot reach on v2.

## [1.1.0](https://github.com/MrCarb0n/opencode-mcp-watchdog/compare/v1.0.3...v1.1.0) (2026-09-09)


### Features

* opencode-standard rebuild with timeout resilience ([c2625c4](https://github.com/MrCarb0n/opencode-mcp-watchdog/commit/c2625c49704cd4c132e3c910b99697070b2e37be))

## [1.1.0]

### Fixed

- Sequential reconnects: parallel `npx` spawns thundering-herded the registry
  into probe timeouts; servers are now reconnected one at a time.
- A failed status refresh is labeled `showing last-known` instead of being
  presented as fresh data.
- Unknown server states are reported under `other: name (status)` instead of
  being silently dropped.
- `status` and `reconnect` return a friendly retry message when the status
  probe itself fails, instead of throwing.

### Changed

- TypeScript source (`src/`, strict) compiled to `dist/`; the published
  bundle is typechecked against the real opencode SDK types. The plugin
  export is now `McpWatchdogPlugin` (opencode naming convention);
  `McpWatchdog` remains as a backwards-compatible alias.
- All-green startup checks stay quiet (still toasts on recovery/failure).
- Explicit `reconnect` always runs — it bypasses the 15s event cooldown.
- Headless mode (`serve`/`web`) logs the summary at `info` level.
- Long server errors are shortened in `status` output and toasts.

### Added

- `node:test` suite (`npm test`), syntax check (`npm run check`), CI matrix
  across Node 18/20/22.
