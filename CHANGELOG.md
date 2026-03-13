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
- `connect()` entry point stub (implementation in progress)
- `Client` interface: `send()`, `close()`, `done`
- Unit tests for backoff, errors, and options
