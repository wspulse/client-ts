# wspulse/client-ts

[![CI](https://github.com/wspulse/client-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/wspulse/client-ts/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@wspulse/client-ts)](https://www.npmjs.com/package/@wspulse/client-ts)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?logo=typescript)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg?logo=node.js)](https://nodejs.org)
[![Browser](https://img.shields.io/badge/Browser-supported-green.svg?logo=googlechrome)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A TypeScript WebSocket client with optional automatic reconnection, designed for use with [wspulse/server](https://github.com/wspulse/server).

Works in **Node.js 20+** (via [`ws`](https://github.com/websockets/ws)) and **browsers** (native `WebSocket`).

**Status:** v0 — API is being stabilized. Package: `@wspulse/client-ts`.

---

## Design Goals

- Thin client: connect, send, receive, auto-reconnect
- Matches server-side `Message` wire format via JSON text WebSocket frames
- Exponential backoff with configurable retries (equal jitter)
- Transport drop vs. permanent disconnect callbacks
- Node.js and browser support from a single package

---

## Install

```bash
npm install @wspulse/client-ts
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
import { connect } from "@wspulse/client-ts";

const client = await connect("ws://localhost:8080/ws?room=r1&token=xyz", {
  onMessage(msg) {
    console.log(`[${msg.event}]`, msg.payload);
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
  import { connect } from "@wspulse/client-ts";

  const client = await connect("wss://api.example.com/ws?room=lobby", {
    onMessage(msg) {
      console.log(msg.event, msg.payload);
    },
  });

  document.querySelector("#send").addEventListener("click", () => {
    client.send({ event: "chat.message", payload: { text: "hi!" } });
  });
</script>
```

---

## Message Format

The default `JSONCodec` encodes messages as JSON text WebSocket frames:

```json
{
  "event": "chat.message",
  "payload": { "text": "hello" }
}
```

To use a custom wire format (e.g. Protocol Buffers), implement the `Codec` interface:

```ts
import type { Codec, Message } from "@wspulse/client-ts";

const myCodec: Codec = {
  binaryType: "binary",
  encode(msg: Message): Uint8Array {
    // serialize to binary
  },
  decode(data: string | Uint8Array): Message {
    // deserialize from binary
  },
};

const client = await connect(url, { codec: myCodec });
```

The `event` field is the routing key on the server side. Set `msg.event` to match the handler registered with `r.On("chat.message", ...)` on the server. The `payload` field carries arbitrary data — the codec determines how it is serialized.

```ts
// Send a typed message — server routes by "event"
client.send({
  event: "chat.message",
  payload: { text: "hello world" },
});

// Receive typed messages
const client = await connect(url, {
  onMessage(msg) {
    switch (msg.event) {
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

| Symbol                  | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `Client`                | Interface: `send()`, `close()`, `done`          |
| `connect(url, opts?)`   | Connect and return a `Client`                   |
| `Message`               | Interface: `{ event?, payload? }`               |
| `Codec`                 | Interface: `encode()`, `decode()`, `binaryType` |
| `JSONCodec`             | Default codec — JSON text frames                |
| `ClientOptions`         | Options object type                             |
| `ConnectionClosedError` | Thrown by `send()` after `close()`              |
| `RetriesExhaustedError` | Passed to `onDisconnect` when retries exceeded  |
| `ConnectionLostError`   | Passed to `onDisconnect` when no auto-reconnect |
| `backoff()`             | Backoff formula (exported for testing/reuse)    |

### Client Options

| Option               | Type                                  | Default           |
| -------------------- | ------------------------------------- | ----------------- |
| `onMessage`          | `(msg: Message) => void`              | no-op             |
| `onDisconnect`       | `(err: Error \| null) => void`        | no-op             |
| `onTransportRestore` | `() => void`                          | no-op             |
| `onTransportDrop`    | `(err: Error \| null) => void`        | no-op             |
| `autoReconnect`      | `{ maxRetries, baseDelay, maxDelay }` | disabled          |
| `codec`              | `Codec`                               | `JSONCodec`       |
| `writeWait`          | `number` (ms)                         | 10 000            |
| `maxMessageSize`     | `number` (bytes)                      | 1 MiB (1 048 576) |
| `dialHeaders`        | `Record<string, string>`              | `{}`              |

---

## Logging

The client logs warnings via `console.warn` when an inbound message cannot be decoded by the configured codec. This is always enabled.

**Disable logging** by temporarily overriding `console.warn`:

```ts
const originalWarn = console.warn;
console.warn = () => {};
try {
  // code that uses @wspulse/client-ts
} finally {
  console.warn = originalWarn;
}
```

---

## Features

- **Auto-reconnect** — exponential backoff with configurable max retries, base delay, and max delay. Equal jitter formula: delay ∈ `[half, full]` where full = min(base × 2^attempt, max).
- **Transport drop callback** — `onTransportDrop` fires on every transport death (with the error) and on a clean `close()` call (with `null`). Fires exactly once per transport lifecycle. Useful for metrics and logging.
- **Transport restore callback** — `onTransportRestore` fires after a successful reconnect (not on the initial connect). Useful for re-subscribing or refreshing state.
- **Permanent disconnect callback** — `onDisconnect` fires exactly once when the client is truly done (`close()` called, retries exhausted, or connection lost without auto-reconnect).
- **Max message size** — Inbound messages exceeding `maxMessageSize` are rejected with close code 1009.
- **Backpressure** — bounded 256-message send buffer; throws `SendBufferFullError` when full.
- **`done` Promise** — resolves when the client reaches CLOSED state. Await it to block until permanently disconnected.

---

## Platform Notes

| Feature               | Node.js 20+                         | Browser                                      |
| --------------------- | ----------------------------------- | -------------------------------------------- |
| WebSocket transport   | `ws` package (peer dep)             | Native `WebSocket` API                       |
| `dialHeaders`         | ✅ Passed as HTTP headers           | ⚠️ Silently ignored (browser API limitation) |
| `maxMessageSize`      | ✅                                  | ✅                                           |
| Auto-reconnect        | ✅                                  | ✅                                           |

## Development

```bash
make fmt       # auto-format source files
make check     # validate format, lint, unit tests (fails on unformatted code)
make test      # vitest run
make cover     # vitest run --coverage
make build     # tsup → dist/ (ESM + CJS)
```

---

## Related Modules

| Module                                                    | Description                          |
| --------------------------------------------------------- | ------------------------------------ |
| [wspulse/server](https://github.com/wspulse/server)       | WebSocket server                     |
| [wspulse/client-go](https://github.com/wspulse/client-go) | Go client (reference implementation) |
