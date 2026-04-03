/**
 * Component tests — miscellaneous (concurrency, buffer, heartbeat).
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import type { Frame } from "../../src/frame.js";
import { ConnectionLostError, SendBufferFullError } from "../../src/errors.js";
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

describe("component: misc", () => {
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
});
