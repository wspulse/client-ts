# Integration Test Coverage — client-ts

> **Contract:** all scenarios defined in
> [`.github/doc/contracts/client/integration-test-scenarios.md`](https://github.com/wspulse/.github/blob/main/doc/contracts/client/integration-test-scenarios.md)

Integration tests run against a live `wspulse/server` via the shared
[testserver](https://github.com/wspulse/testserver). The Go test server is spawned by vitest
`globalSetup` (`test/global-setup.ts`).

**Run:** `npm run test:integration` (or `make test-integration`)

## Scenario Matrix

| #   | Scenario                                                          | Test Name                                                              | Query Params      |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| 1   | Connect → send → echo → close clean                               | `connects, sends a frame, receives echo, and closes cleanly`           | —                 |
| 2   | Server drops → onTransportDrop + onDisconnect (no reconnect)      | `server drop fires onTransportDrop and onDisconnect without reconnect` | `?id=…`           |
| 3   | Auto-reconnect: server drops → reconnects within maxRetries       | `reconnects after kick and resumes echo (scenario 3)`                  | `?id=…`           |
| 4   | Max retries exhausted → `onDisconnect(RetriesExhaustedError)`     | `fires RetriesExhaustedError after shutdown (scenario 4)`              | `?id=…`           |
| 5   | `close()` during reconnect → loop stops, `onDisconnect(null)`     | `close() during reconnect fires onDisconnect(null) (scenario 5)`       | `?id=…`           |
| 6   | `send()` on closed client → `ConnectionClosedError`               | `send after close throws ConnectionClosedError`                        | —                 |
| 7   | Heartbeat pong timeout → `ConnectionLostError`                    | `pong timeout triggers ConnectionLostError (scenario 7)`               | `?ignore_pings=1` |
| 8   | Concurrent sends: no data race or interleaving                    | N/A — single-threaded JS (see Additional Tests)                        | —                 |
| 9   | Concurrent `close()` + transport drop → onDisconnect exactly once | `close() racing with transport drop fires onDisconnect exactly once`   | `?id=…`           |

## Additional Tests

| Test Name                                                 | What It Covers                             |
| --------------------------------------------------------- | ------------------------------------------ |
| `round-trips all Frame fields (id, event, payload)`       | Full Frame field fidelity through the wire |
| `handles server rejection (ConnectFunc error) gracefully` | Server returns HTTP 403 via `?reject=1`    |
| `sends multiple frames and receives them in order`        | Message ordering preservation              |
| `connects to a specific room via query param`             | Room routing via `?room=…`                 |
| `concurrent sends do not race`                            | 50 senders × 5 messages each (scenario 8)  |
| `detects server-initiated kick via control API`           | `POST /kick?id=…` → `onDisconnect(Error)`  |
| `onDisconnect fires exactly once on close`                | User-initiated close → single callback     |
| `close is idempotent`                                     | Multiple `close()` calls → single callback |

**Total: 16 integration tests** (8 scenarios + 8 additional; scenario 8 N/A → moved to additional).
