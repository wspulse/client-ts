# Component Test Coverage — client-ts

> **Contract:** all scenarios defined in
> [`.github/doc/contracts/client/test-scenarios.md`](https://github.com/wspulse/.github/blob/main/doc/contracts/client/test-scenarios.md)

Component tests use a mock transport (`test/component/mock-transport.ts`) to simulate
WebSocket behaviour without real network I/O. The suite is designed to run
reliably as part of `make check` (via `npx vitest run`).

**Run:** `make test` (or `npx vitest run`)

## Scenario Matrix

| #   | Scenario                                                           | Test Name                                                              |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1   | Connect -> send -> echo -> close clean                             | `connects, sends a message, receives echo, and closes cleanly`         |
| 2   | Server drops -> onTransportDrop + onDisconnect (no reconnect)      | `server drop fires onTransportDrop and onDisconnect without reconnect` |
| 3   | Auto-reconnect: server drops -> reconnects within maxRetries       | `reconnects after transport drop and resumes sending`                  |
| 4   | Max retries exhausted -> `onDisconnect(RetriesExhaustedError)`     | `fires RetriesExhaustedError after max retries exhausted`              |
| 5   | `close()` during reconnect -> loop stops, `onDisconnect(null)`     | `close() during reconnect fires onDisconnect(null)`                    |
| 6   | `send()` on closed client -> `ConnectionClosedError`               | `send after close throws ConnectionClosedError`                        |
| 7   | Concurrent sends: no data race or interleaving                     | N/A -- single-threaded JS (see Additional Tests)                       |
| 8   | Concurrent `close()` + transport drop -> onDisconnect exactly once | `close() racing with transport drop fires onDisconnect exactly once`   |

## Additional Tests

| Test Name                                             | What It Covers                               |
| ----------------------------------------------------- | -------------------------------------------- |
| `round-trips all Message fields (event, payload)`     | Full Message field fidelity through codec    |
| `handles dial failure gracefully`                     | Dialer error rejects connect() Promise       |
| `sends multiple messages and receives them in order`  | Message ordering preservation                |
| `concurrent sends do not race`                        | 50 senders x 5 messages each (scenario 7)    |
| `detects server-initiated close`                      | Transport close -> `onDisconnect(Error)`     |
| `onDisconnect fires exactly once on close`            | User-initiated close -> single callback      |
| `close is idempotent`                                 | Multiple `close()` calls -> single callback  |
| `send buffer full throws SendBufferFullError`         | Buffer overflow enforcement                  |
| `onDisconnect fires exactly once on transport drop`   | Transport drop -> single callback            |
| `onTransportRestore does not fire on initial connect` | Restore callback reserved for reconnect only |
| `passes URL with query params to dialer`              | URL forwarding to dialer function            |

**Coverage rows: 19** (8 scenario rows + 11 additional). This is the count of documented coverage rows, not the full `it(...)` test count under `test/component/`. Scenario 7 is N/A as a dedicated scenario — covered by `concurrent sends do not race` in Additional Tests.

## Legacy Integration Tests

The original integration tests (`test/integration.test.ts`) tested against a live
`wspulse/server` via the shared testserver. These have been superseded by the
component tests above. The integration test file and `vitest.integration.config.ts`
were removed in v0.5.0; there is no longer a `make test-integration` target.
