/**
 * Component tests — client-ts with mock transport.
 *
 * These tests replace the integration tests that previously required a live
 * wspulse/server. All I/O is simulated via MockTransport, making the tests
 * fully deterministic and fast.
 *
 * Each test creates a MockDialer, calls connect() with _dialer, and
 * drives behaviour via injectMessage(), injectClose(), etc.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../src/client.js";
import type { Client } from "../src/client.js";
import type { Frame } from "../src/frame.js";
import {
  ConnectionClosedError,
  ConnectionLostError,
  RetriesExhaustedError,
  SendBufferFullError,
} from "../src/errors.js";
import { MockTransport, MockDialer } from "./mock-transport.js";

// ── test state ──────────────────────────────────────────────────────────────────

let testClient: Client | null = null;

afterEach(async () => {
  if (testClient) {
    testClient.close();
    await testClient.done;
    testClient = null;
  }
});

/**
 * Helper: create a connected client with a single mock transport.
 *
 * Returns both the client and the underlying transport for injecting
 * server-side events.
 */
async function connectMock(
  opts?: Parameters<typeof connect>[1],
  transport?: MockTransport,
): Promise<{ client: Client; transport: MockTransport }> {
  const t = transport ?? new MockTransport();
  const dialer = new MockDialer([t]);
  const client = await connect("ws://mock/ws", {
    ...opts,
    _dialer: dialer.dial,
  });
  testClient = client;
  return { client, transport: t };
}

// ── tests ───────────────────────────────────────────────────────────────────────

describe("component: wspulse client", () => {
  // Scenario 1: Connect -> send -> receive echo -> close clean
  it("connects, sends a frame, receives echo, and closes cleanly", async () => {
    const received: Frame[] = [];
    let disconnectErr: Error | null | undefined;

    const { client, transport } = await connectMock({
      onMessage(frame) {
        received.push(frame);
      },
      onDisconnect(err) {
        disconnectErr = err;
      },
    });

    client.send({ event: "msg", payload: { text: "hello" } });

    // Wait for drain timer to flush.
    await new Promise((r) => setTimeout(r, 10));

    // Verify sent data.
    expect(transport.sent.length).toBe(1);
    const sentFrame = JSON.parse(transport.sent[0] as string) as Frame;
    expect(sentFrame.event).toBe("msg");
    expect(sentFrame.payload).toEqual({ text: "hello" });

    // Simulate echo from server.
    transport.injectMessage(transport.sent[0] as string);

    expect(received.length).toBe(1);
    expect(received[0]?.event).toBe("msg");
    expect(received[0]?.payload).toEqual({ text: "hello" });

    client.close();
    await client.done;

    expect(disconnectErr).toBeNull();
  });

  // Frame field round-trip
  it("round-trips all Frame fields (event, payload)", async () => {
    const received: Frame[] = [];

    const { client, transport } = await connectMock({
      onMessage(frame) {
        received.push(frame);
      },
    });

    const outbound: Frame = {
      event: "chat.message",
      payload: { user: "alice", text: "hi", n: 42, nested: { ok: true } },
    };
    client.send(outbound);

    // Wait for drain.
    await new Promise((r) => setTimeout(r, 10));

    // Echo back.
    transport.injectMessage(transport.sent[0] as string);

    expect(received[0]).toEqual(outbound);
  });

  // Server rejection (dial failure)
  it("handles dial failure gracefully", async () => {
    const dialer = new MockDialer([new Error("connection refused")]);

    await expect(
      connect("ws://mock/ws", { _dialer: dialer.dial }),
    ).rejects.toThrow("connection refused");
  });

  // Message ordering
  it("sends multiple frames and receives them in order", async () => {
    const received: Frame[] = [];

    const { client, transport } = await connectMock({
      onMessage(frame) {
        received.push(frame);
      },
    });

    const count = 10;
    for (let i = 0; i < count; i++) {
      client.send({ event: "seq", payload: { i } });
    }

    // Wait for drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(transport.sent.length).toBe(count);

    // Echo all back in order.
    for (let i = 0; i < count; i++) {
      transport.injectMessage(transport.sent[i] as string);
    }

    expect(received.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(received[i]?.event).toBe("seq");
      expect(received[i]?.payload).toEqual({ i });
    }
  });

  // Scenario 6: send after close -> ConnectionClosedError
  it("send after close throws ConnectionClosedError", async () => {
    const { client } = await connectMock();

    client.close();
    await client.done;

    expect(() => {
      client.send({ event: "msg" });
    }).toThrow(ConnectionClosedError);
  });

  // Concurrent sends (single-threaded JS — no data race, but verifies
  // multiple synchronous sends from different microtask contexts)
  it("concurrent sends do not race", async () => {
    const { client, transport } = await connectMock();

    const senders = 50;
    const msgsPerSender = 5;
    const total = senders * msgsPerSender;

    await Promise.all(
      Array.from({ length: senders }, (_, s) =>
        Promise.resolve().then(() => {
          for (let m = 0; m < msgsPerSender; m++) {
            client.send({ event: "concurrent", payload: { s, m } });
          }
        }),
      ),
    );

    // Wait for drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(transport.sent.length).toBe(total);

    // Verify all frames have the expected event.
    for (const raw of transport.sent) {
      const f = JSON.parse(raw as string) as Frame;
      expect(f.event).toBe("concurrent");
    }
  });

  // onDisconnect fires exactly once on close
  it("onDisconnect fires exactly once on close", async () => {
    let disconnectCount = 0;

    const { client } = await connectMock({
      onDisconnect() {
        disconnectCount++;
      },
    });

    client.close();
    await client.done;

    // Brief window for any erroneous second call.
    await new Promise((r) => setTimeout(r, 50));

    expect(disconnectCount).toBe(1);
  });

  // Scenario 2: Server drop -> onTransportDrop + onDisconnect (no reconnect)
  it("server drop fires onTransportDrop and onDisconnect without reconnect", async () => {
    let transportDropErr: Error | undefined;
    let disconnectErr: Error | null | undefined;

    const { transport } = await connectMock({
      onTransportDrop(err) {
        transportDropErr = err;
      },
      onDisconnect(err) {
        disconnectErr = err;
      },
    });

    // Simulate server-initiated close.
    transport.injectClose(1006, "");

    expect(transportDropErr).toBeInstanceOf(Error);
    expect(disconnectErr).toBeInstanceOf(ConnectionLostError);
  });

  // Close idempotency
  it("close is idempotent", async () => {
    let disconnectCount = 0;

    const { client } = await connectMock({
      onDisconnect() {
        disconnectCount++;
      },
    });

    client.close();
    client.close();
    client.close();
    await client.done;

    expect(disconnectCount).toBe(1);
  });

  // Scenario 9: close() racing with transport drop -> onDisconnect exactly once
  it("close() racing with transport drop fires onDisconnect exactly once", async () => {
    let disconnectCount = 0;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    const { client, transport } = await connectMock({
      onDisconnect() {
        disconnectCount++;
        disconnectResolve();
      },
    });

    // Fire both simultaneously — one is a transport drop, the other
    // is a user-initiated close.
    transport.injectClose(1006, "");
    client.close();

    await disconnected;

    // Brief window for any erroneous second call.
    await new Promise((r) => setTimeout(r, 50));

    expect(disconnectCount).toBe(1);
  });

  // Server-initiated kick (same as transport drop detection)
  it("detects server-initiated close", async () => {
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    const { transport } = await connectMock({
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
    });

    transport.injectClose(1001, "going away");

    await disconnected;

    // Server-initiated close -> client sees an Error instance.
    expect(disconnectErr).toBeInstanceOf(Error);
  });

  // Scenario 3: Auto-reconnect after transport drop
  it("reconnects after transport drop and resumes sending", async () => {
    const received: Frame[] = [];
    let transportRestoreCount = 0;
    let restoredResolve: () => void = () => {};
    const restored = new Promise<void>((r) => {
      restoredResolve = r;
    });

    const t1 = new MockTransport();
    const t2 = new MockTransport();
    const dialer = new MockDialer([t1, t2]);

    testClient = await connect("ws://mock/ws", {
      onMessage(frame) {
        received.push(frame);
      },
      onTransportRestore() {
        transportRestoreCount++;
        restoredResolve();
      },
      autoReconnect: { maxRetries: 5, baseDelay: 10, maxDelay: 50 },
      _dialer: dialer.dial,
    });

    // Send before drop.
    testClient.send({ event: "before", payload: "drop" });
    await new Promise((r) => setTimeout(r, 10));
    expect(t1.sent.length).toBe(1);

    // Simulate transport drop.
    t1.injectClose(1006, "");

    // Wait for reconnect to succeed.
    await restored;

    // Send after reconnect — goes to t2.
    testClient.send({ event: "after", payload: "reconnect" });
    await new Promise((r) => setTimeout(r, 10));
    expect(t2.sent.length).toBe(1);

    // Echo back from t2.
    t2.injectMessage(t2.sent[0] as string);
    expect(received.some((f) => f.event === "after")).toBe(true);

    expect(transportRestoreCount).toBe(1);
  });

  // Scenario 4: Max retries exhausted -> RetriesExhaustedError
  it("fires RetriesExhaustedError after max retries exhausted", async () => {
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    const t1 = new MockTransport();
    // 2 retries, both fail.
    const dialer = new MockDialer([
      t1,
      new Error("dial failed 1"),
      new Error("dial failed 2"),
    ]);

    testClient = await connect("ws://mock/ws", {
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
      autoReconnect: { maxRetries: 2, baseDelay: 10, maxDelay: 20 },
      _dialer: dialer.dial,
    });

    // Trigger transport drop to start reconnect loop.
    t1.injectClose(1006, "");

    await disconnected;

    expect(disconnectErr).toBeInstanceOf(RetriesExhaustedError);
  });

  // Scenario 5: close() during reconnect -> onDisconnect(null)
  it("close() during reconnect fires onDisconnect(null)", async () => {
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    const t1 = new MockTransport();
    // Reconnect will never succeed — we close() before it gets a chance.
    const dialer = new MockDialer([
      t1,
      new Error("dial fail 1"),
      new Error("dial fail 2"),
      new Error("dial fail 3"),
      new Error("dial fail 4"),
      new Error("dial fail 5"),
      new Error("dial fail 6"),
      new Error("dial fail 7"),
      new Error("dial fail 8"),
      new Error("dial fail 9"),
      new Error("dial fail 10"),
    ]);

    testClient = await connect("ws://mock/ws", {
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
      onTransportDrop() {
        // Close while the reconnect loop is active.
        queueMicrotask(() => {
          testClient?.close();
        });
      },
      autoReconnect: { maxRetries: 10, baseDelay: 100, maxDelay: 500 },
      _dialer: dialer.dial,
    });

    // Trigger transport drop.
    t1.injectClose(1006, "");

    await disconnected;

    // User-initiated close during reconnect -> onDisconnect(null).
    expect(disconnectErr).toBeNull();
  });

  // Scenario 7: Pong timeout -> ConnectionLostError
  it("pong timeout triggers ConnectionLostError", async () => {
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    const t = new MockTransport();
    // Stop responding to pings so the pong deadline fires.
    t.suppressPongs();

    const { client } = await connectMock(
      {
        onDisconnect(err) {
          disconnectErr = err;
          disconnectResolve();
        },
        heartbeat: { pingPeriod: 50, pongWait: 150 },
      },
      t,
    );

    // Wait for pong timeout -> transport drop -> ConnectionLostError.
    await disconnected;

    expect(disconnectErr).toBeInstanceOf(ConnectionLostError);

    // Prevent afterEach from double-closing.
    testClient = null;
    void client;
  });

  // Send buffer full -> SendBufferFullError
  it("send buffer full throws SendBufferFullError", async () => {
    const { client } = await connectMock({
      sendBufferSize: 2,
    });

    // Fill the buffer (drain timer has not fired yet).
    client.send({ event: "a" });
    client.send({ event: "b" });

    // Third send should throw.
    expect(() => {
      client.send({ event: "c" });
    }).toThrow(SendBufferFullError);
  });

  // onDisconnect fires exactly once (duplicate of the earlier test but
  // with a transport drop path to ensure both clean and unclean paths
  // fire exactly once)
  it("onDisconnect fires exactly once on transport drop", async () => {
    let disconnectCount = 0;

    const { transport } = await connectMock({
      onDisconnect() {
        disconnectCount++;
      },
    });

    transport.injectClose(1006, "");

    // Brief window for any erroneous second call.
    await new Promise((r) => setTimeout(r, 50));

    expect(disconnectCount).toBe(1);
  });

  // onTransportRestore does NOT fire on initial connect
  it("onTransportRestore does not fire on initial connect", async () => {
    let restoreCount = 0;

    await connectMock({
      onTransportRestore() {
        restoreCount++;
      },
    });

    // Wait a bit to ensure no spurious call.
    await new Promise((r) => setTimeout(r, 50));

    expect(restoreCount).toBe(0);
  });

  // Verify room-like query params pass through (URL is just forwarded
  // to the dialer, so we verify the dialer receives the full URL)
  it("passes URL with query params to dialer", async () => {
    let dialedUrl = "";
    const t = new MockTransport();

    testClient = await connect("ws://mock/ws?room=myroom", {
      _dialer: async (url) => {
        dialedUrl = url;
        return t;
      },
    });

    expect(dialedUrl).toBe("ws://mock/ws?room=myroom");
  });
});
