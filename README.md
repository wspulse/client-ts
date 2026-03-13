# wspulse/client-ts

A TypeScript WebSocket client with optional automatic reconnection, designed for use with [wspulse/server](https://github.com/wspulse/server).

Works in **Node.js 20+** (via [`ws`](https://github.com/websockets/ws)) and **browsers** (native `WebSocket`).

**Status:** v0 — API is being stabilized. Package: `@wspulse/client`.

---

## Design Goals

- Thin client: connect, send, receive, auto-reconnect
- Matches server-side `Frame` wire format via JSON text frames
- Exponential backoff with configurable retries (equal jitter)
- Transport drop vs. permanent disconnect callbacks
- Node.js and browser support from a single package

---

## Install

```bash
npm install @wspulse/client
```

Node.js also needs the `ws` peer dependency:

```bash
npm install ws
```

> Browsers use the native `WebSocket` API — no extra dependency needed.

---

## Quick Start

### Node.js

```ts
import { connect } from "@wspulse/client";

const client = await connect("ws://localhost:8080/ws?room=r1&token=xyz", {
  onMessage(frame) {
    console.log(`[${frame.event}]`, frame.payload);
  },
  autoReconnect: {
    maxRetries: 5,
    baseDelay: 1000,
    maxDelay: 30_000,
  },
});

client.send({ event: "msg", payload: { text: "hello" } });

// Wait until permanently disconnected.
await client.done;
```

### Browser

```html
<script type="module">
  import { connect } from "@wspulse/client";

  const client = await connect("wss://api.example.com/ws?room=lobby", {
    onMessage(frame) {
      console.log(frame.event, frame.payload);
    },
  });

  document.querySelector("#send").addEventListener("click", () => {
    client.send({ event: "chat.message", payload: { text: "hi!" } });
  });
</script>
```

---

## Frame Format

Every message exchanged between server and client is a JSON text frame:

```json
{
  "id": "msg-001",
  "event": "chat.message",
  "payload": { "text": "hello" }
}
```

The `event` field is the routing key on the server side. Set `frame.event` to match the handler registered with `r.On("chat.message", ...)` on the server. The `payload` field carries arbitrary JSON — the library does not inspect it.

```ts
// Send a typed frame — server routes by "event"
client.send({
  event: "chat.message",
  payload: { text: "hello world" },
});

// Receive typed frames
const client = await connect(url, {
  onMessage(frame) {
    switch (frame.event) {
      case "chat.message":
        // handle message
        break;
      case "chat.ack":
        // handle acknowledgement
        break;
    }
  },
});
```

---

## Public API Surface

| Symbol                  | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `Client`                | Interface: `send()`, `close()`, `done`         |
| `connect(url, opts?)`   | Connect and return a `Client`                  |
| `Frame`                 | Interface: `{ id?, event?, payload? }`         |
| `ClientOptions`         | Options object type                            |
| `ConnectionClosedError` | Thrown by `send()` after `close()`              |
| `RetriesExhaustedError` | Passed to `onDisconnect` when retries exceeded |
| `ConnectionLostError`   | Passed to `onDisconnect` when no auto-reconnect|
| `backoff()`             | Backoff formula (exported for testing/reuse)   |

### Client Options

| Option           | Type                                    | Default             |
| ---------------- | --------------------------------------- | ------------------- |
| `onMessage`      | `(frame: Frame) => void`               | no-op               |
| `onDisconnect`   | `(err: Error \| null) => void`          | no-op               |
| `onReconnect`    | `(attempt: number) => void`            | no-op               |
| `onTransportDrop`| `(err: Error) => void`                 | no-op               |
| `autoReconnect`  | `{ maxRetries, baseDelay, maxDelay }`  | disabled             |
| `heartbeat`      | `{ pingPeriod, pongWait }` (ms)        | 20 000 / 60 000     |
| `writeWait`      | `number` (ms)                          | 10 000               |
| `maxMessageSize` | `number` (bytes)                       | 1 MiB (1 048 576)   |
| `dialHeaders`    | `Record<string, string>`               | `{}`                 |

---

## Features

- **Auto-reconnect** — exponential backoff with configurable max retries, base delay, and max delay. Equal jitter formula: delay ∈ `[half, full]` where full = min(base × 2^attempt, max).
- **Transport drop callback** — `onTransportDrop` fires on every transport death, even when auto-reconnect follows. Useful for metrics and logging.
- **Permanent disconnect callback** — `onDisconnect` fires exactly once when the client is truly done (`close()` called, retries exhausted, or connection lost without auto-reconnect).
- **Heartbeat** — Client-side Ping/Pong keeps the connection alive and detects silently-dead servers. Node.js only (browsers handle Ping/Pong automatically at the protocol level).
- **Max message size** — Inbound messages exceeding `maxMessageSize` are rejected with close code 1009.
- **Backpressure** — bounded 256-frame send buffer; oldest frame is dropped (head-drop) when full.
- **`done` Promise** — resolves when the client reaches CLOSED state. Await it to block until permanently disconnected.

---

## Platform Notes

| Feature | Node.js 20+ | Browser |
| ------- | ----------- | ------- |
| WebSocket transport | `ws` package (peer dep) | Native `WebSocket` API |
| `dialHeaders` | ✅ Passed as HTTP headers | ⚠️ Silently ignored (browser API limitation) |
| Heartbeat (Ping/Pong) | ✅ Client sends Ping, monitors Pong | ⚠️ No-op (browser handles automatically) |
| `maxMessageSize` | ✅ | ✅ |
| Auto-reconnect | ✅ | ✅ |

---

## Development

```bash
make check     # fmt → lint → test (with race detector equivalent)
make test      # vitest run
make cover     # vitest run --coverage
make build     # tsc → dist/
```

---

## Related Modules

| Module                                                  | Description                              |
| ------------------------------------------------------- | ---------------------------------------- |
| [wspulse/core](https://github.com/wspulse/core)         | Shared types, codecs, and event router   |
| [wspulse/server](https://github.com/wspulse/server)     | WebSocket server                         |
| [wspulse/client-go](https://github.com/wspulse/client-go) | Go client (reference implementation)  |
