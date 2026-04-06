# Changelog

## [Unreleased]

---

## [0.5.1] - 2026-04-06

### Fixed

- Normal write path now enforces `writeWait` per frame on Node.js. Previously only the shutdown flush used `sendWithTimeout`; a stalled socket during regular sends would block indefinitely without triggering `onTransportDrop`. Browser path is unchanged (fire-and-forget).

---

## [0.5.0] - 2026-04-04

### Added

- `_clock` option in `ClientOptions` for injecting a deterministic timer implementation in tests (test-only, `@internal`)
- `Clock` interface in `src/clock.ts` — abstracts `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`
- `FakeClock` in `test/component/fake-clock.ts` — async `advance(ms)` drives virtual time for deterministic component tests
- `connect()` auto-converts `http://` to `ws://` and `https://` to `wss://` (case-insensitive per RFC 3986). Other schemes are passed through to the underlying WebSocket library.
- `sendBufferSize` option — configurable outbound buffer capacity [1, 4096], default 256
- `Transport` interface exported from `src/transport.ts` for mock implementations
- `_dialer` option in `ClientOptions` for injecting test transport (test-only)
- 19 reliable component tests (`test/component/*.test.ts`) using mock transport — zero network I/O

### Changed

- **BREAKING**: `onTransportDrop` callback signature changed from `(err: Error) => void` to `(err: Error | null) => void`. The callback now fires on clean `close()` calls with `err = null`, in addition to unexpected transport drops. When `close()` is called while reconnecting, the callback does not fire again.
- `test-integration` CI job removed; component tests run as part of `lint-test`

### Removed

- **BREAKING**: `Frame.id` field removed — transport layer does not use it. Applications needing message IDs should use payload.

---

## [0.4.0] - 2026-03-24

### Added

- `onTransportRestore` callback option, fired after a successful reconnect

### Removed

- `onReconnect` callback option (replaced by `onTransportRestore`) (**breaking**)

---

## [0.3.0] - 2026-03-22

### Changed

- **BREAKING**: negative `maxRetries` now throws instead of being treated as
  unlimited. Use `0` for unlimited retries.
- Validation error messages use fully-qualified field names (`heartbeat.pongWait`,
  `autoReconnect.baseDelay`) to match the config validation contract.

### Added

- Config validation in `resolveOptions()`: all 15 rules from the config
  validation contract are now enforced at construction time.
- Test coverage for error classes and callback invocations.

---

## [0.2.2] - 2026-03-21

### Fixed

- Decode failures were silently swallowed. Now logs `console.warn` with error
  details, matching client-go and client-kt behaviour.

### Added

- CI/CD: auto-label on PR opened, tag-triggered GitHub Release with
  `release.yml` changelog categories.

---

## [0.2.1] - 2026-03-21

### Fixed

- `connect()` now rejects immediately on initial dial failure regardless of
  `autoReconnect` configuration. No callbacks fire and no `Client` is returned.
  Auto-reconnect only activates after a successful initial connection drops.
- Fixed pong listener leak across reconnects: handler is now stored and removed
  in `stopHeartbeat`.

### Added

- Integration tests: pong timeout, concurrent close/transport-drop race,
  scenario 2/9 coverage, shared testserver support.
- CI/CD: auto-label on PR opened, tag-triggered GitHub Release, `release.yml`
  changelog categories.

---

## [0.2.0] - 2026-03-16

### Changed

- **BREAKING**: `send()` now throws `SendBufferFullError` when the internal
  buffer is full, instead of silently dropping the oldest frame (head-drop).
  Client-side 1:1 connections must not silently discard frames; callers
  handle the error explicitly.

### Added

- `SendBufferFullError` error class

---

## [0.1.0] - 2026-03-16

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
- Bounded 256-frame send buffer
- 44 unit tests across 6 test files (integration tests run separately)
- CI workflow: lint → type-check → test on Node 20 and 22 (3-job matrix)
- README with quick-start, API reference, and platform notes
