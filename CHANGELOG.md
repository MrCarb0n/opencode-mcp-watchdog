# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
