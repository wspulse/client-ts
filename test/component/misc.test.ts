/**
 * Component tests — miscellaneous (concurrency, buffer, heartbeat).
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import type { Frame } from "../../src/frame.js";
import { ConnectionLostError, SendBufferFullError } from "../../src/errors.js";
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

    // Advance past the drain timer (5 ms).
    await clock.advance(10);

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
    expect((dropErr as Error).message).toContain("transport closed unexpectedly");

    // Prevent afterEach from double-closing.
    testClient = null;
    void client;
  });

  // Scenario 7: Pong timeout -> ConnectionLostError
  it("pong timeout triggers ConnectionLostError", async () => {
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });
    const clock = new FakeClock();

    const t = new MockTransport();
    // Stop responding to pings so the pong deadline fires.
    t.suppressPongs();

    const { client } = await connectMock(
      clock,
      {
        onDisconnect(err) {
          disconnectErr = err;
          disconnectResolve();
        },
        heartbeat: { pingPeriod: 50, pongWait: 150 },
      },
      t,
    );

    // Advance past the pong deadline (150 ms) to trigger ConnectionLostError.
    await clock.advance(200);
    await disconnected;

    expect(disconnectErr).toBeInstanceOf(ConnectionLostError);

    // Prevent afterEach from double-closing.
    testClient = null;
    void client;
  });
});
