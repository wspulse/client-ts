# Changelog

## [Unreleased]

---

## [0.1.0] - 2026-03-13

### Added

- Project scaffold: package.json, tsconfig, vitest, ESLint, Prettier, Makefile
- `Frame` interface (id, event, payload — all optional)
- `ClientOptions` interface with `resolveOptions()` defaults
- `backoff()` function with equal jitter (matches `client-go` formula)
- Error classes: `ConnectionClosedError`, `RetriesExhaustedError`, `ConnectionLostError`
- `connect()` entry point returning a `Client`
- `Client` interface: `send()`, `close()`, `done`
- Auto-reconnect with exponential backoff, configurable `maxRetries`, `baseDelay`, `maxDelay`
- Heartbeat: client-side Ping/Pong with `pingPeriod` and `pongWait` (Node.js `ws` only)
- `writeWait`: write deadline for flushing buffered frames during shutdown
- `maxMessageSize`: inbound message size enforcement (close code 1009)
- `dialHeaders`: custom HTTP headers for WebSocket upgrade (Node.js only)
- Bounded 256-frame send buffer with head-drop on overflow
- 44 unit tests across 6 test files (integration tests run separately)
- CI workflow: lint → type-check → test on Node 20 and 22 (3-job matrix)
- README with quick-start, API reference, and platform notes
