/**
 * Component tests — miscellaneous (concurrency, buffer, write timeout).
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import type { Frame } from "../../src/frame.js";
import { SendBufferFullError } from "../../src/errors.js";
import { MockTransport, MockDialer } from "./mock-transport.js";
import { FakeClock } from "./fake-clock.js";

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
  clock: FakeClock,
  opts?: Parameters<typeof connect>[1],
  transport?: MockTransport,
): Promise<{ client: Client; transport: MockTransport }> {
  const t = transport ?? new MockTransport();
  const dialer = new MockDialer([t]);
  const client = await connect("ws://mock/ws", {
    ...opts,
    _dialer: dialer.dial,
    _clock: clock,
  });
  testClient = client;
  return { client, transport: t };
}

// ── tests ───────────────────────────────────────────────────────────────────────

describe("component: misc", () => {
  // Concurrent sends (single-threaded JS — no data race, but verifies
  // multiple synchronous sends from different microtask contexts)
  it("concurrent sends do not race", async () => {
    const clock = new FakeClock();
    const { client, transport } = await connectMock(clock);

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

    // Advance past the drain timer (5 ms). The async flush sends frames
    // serially; each frame needs one microtask tick for the await. FakeClock
    // flushes 10 microtasks after the timer fires; yield the remaining ticks
    // so all 250 frames complete.
    await clock.advance(10);
    for (let i = 0; i < total; i++) await Promise.resolve();

    expect(transport.sent.length).toBe(total);

    // Verify all frames have the expected event.
    for (const raw of transport.sent) {
      const f = JSON.parse(raw as string) as Frame;
      expect(f.event).toBe("concurrent");
    }
  });

  // Send buffer full -> SendBufferFullError
  it("send buffer full throws SendBufferFullError", async () => {
    const { client } = await connectMock(new FakeClock(), {
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

  // Write timeout: stalled socket triggers onTransportDrop within writeWait
  it("stalled socket triggers onTransportDrop within writeWait", async () => {
    const clock = new FakeClock();
    let dropErr: Error | null | undefined;
    let dropResolve: () => void = () => {};
    const dropped = new Promise<void>((r) => {
      dropResolve = r;
    });

    const t = new MockTransport();
    // Stall sends so the write callback never fires.
    t.stallSends();

    const { client } = await connectMock(
      clock,
      {
        writeWait: 100,
        onTransportDrop(err) {
          dropErr = err;
          dropResolve();
        },
      },
      t,
    );

    // Send a frame — it goes into the buffer.
    client.send({ event: "ping" });

    // Advance past the drain timer (5 ms) so flushSendBuffer fires.
    await clock.advance(10);

    // The send is now stalled. Advance past writeWait (100 ms) to trigger timeout.
    await clock.advance(100);
    await dropped;

    // onTransportDrop must have fired with a non-null error.
    expect(dropErr).toBeInstanceOf(Error);
    expect((dropErr as Error).message).toContain(
      "transport closed unexpectedly",
    );

    // Prevent afterEach from double-closing.
    testClient = null;
    void client;
  });

  // Write timeout: unsent frames preserved and re-drained after reconnect
  it("stalled write preserves buffer across reconnect", async () => {
    const clock = new FakeClock();
    const received: Frame[] = [];
    let restoreResolve: () => void = () => {};
    const restored = new Promise<void>((r) => {
      restoreResolve = r;
    });

    const t1 = new MockTransport();
    t1.stallSends(); // first transport stalls

    const t2 = new MockTransport(); // reconnect transport works normally

    const dialer = new MockDialer([t1, t2]);
    const client = await connect("ws://mock/ws", {
      writeWait: 100,
      autoReconnect: { maxRetries: 3, baseDelay: 10, maxDelay: 50 },
      onMessage(frame) {
        received.push(frame);
      },
      onTransportRestore() {
        restoreResolve();
      },
      _dialer: dialer.dial,
      _clock: clock,
    });
    testClient = client;

    // Send two frames — they go into the buffer.
    client.send({ event: "a" });
    client.send({ event: "b" });

    // Advance past drain timer (5 ms) → flush starts → stalls.
    await clock.advance(10);

    // Advance past writeWait (100 ms) → timeout → transport drop → reconnect.
    // Then advance past backoff delay to let reconnect succeed.
    await clock.advance(200);
    await restored;

    // Give the async flush enough microtask ticks to drain the 2 frames
    // on the new transport.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Both frames should have been sent on the new transport.
    expect(t2.sent.length).toBe(2);
    const f0 = JSON.parse(t2.sent[0] as string) as Frame;
    const f1 = JSON.parse(t2.sent[1] as string) as Frame;
    expect(f0.event).toBe("a");
    expect(f1.event).toBe("b");
  });

  // close() discards unsent buffered frames (contract: close() does not drain)
  it("close discards unsent buffered frames", async () => {
    const clock = new FakeClock();
    const t = new MockTransport();
    const { client } = await connectMock(clock, {}, t);

    // Buffer three frames — drain timer (5 ms) has not fired yet.
    client.send({ event: "a" });
    client.send({ event: "b" });
    client.send({ event: "c" });

    // Close immediately — before drain timer fires.
    client.close();
    await client.done;

    // No frames should have been sent to the transport.
    expect(t.sent.length).toBe(0);
  });

  // Browser path: send() has no callback form, no timeout enforced
  it("browser transport sends without timeout", async () => {
    const clock = new FakeClock();

    // Create a transport without on() — simulates browser WebSocket.
    const t = new MockTransport();
    // Remove on/removeListener to simulate browser environment.
    (t as unknown as Record<string, unknown>).on = undefined;
    (t as unknown as Record<string, unknown>).removeListener = undefined;

    const dialer = new MockDialer([t]);
    const client = await connect("ws://mock/ws", {
      writeWait: 100,
      _dialer: dialer.dial,
      _clock: clock,
    });
    testClient = client;

    client.send({ event: "browser-msg" });

    // Advance past drain timer.
    await clock.advance(10);

    // Frame should be sent synchronously (browser path).
    expect(t.sent.length).toBe(1);
    const f = JSON.parse(t.sent[0] as string) as Frame;
    expect(f.event).toBe("browser-msg");
  });
});
