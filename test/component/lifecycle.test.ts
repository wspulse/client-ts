/**
 * Component tests — connection lifecycle.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import { ConnectionClosedError } from "../../src/errors.js";
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

describe("component: lifecycle", () => {
  // Scenario 6: send after close -> ConnectionClosedError
  it("send after close throws ConnectionClosedError", async () => {
    const { client } = await connectMock(new FakeClock());

    client.close();
    await client.done;

    expect(() => {
      client.send({ event: "msg" });
    }).toThrow(ConnectionClosedError);
  });

  // Close idempotency
  it("close is idempotent", async () => {
    let disconnectCount = 0;

    const { client } = await connectMock(new FakeClock(), {
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

  // Scenario 9: close() racing with transport drop -> both callbacks exactly once
  it("close() racing with transport drop fires onTransportDrop and onDisconnect exactly once", async () => {
    let disconnectCount = 0;
    let transportDropCount = 0;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });
    const clock = new FakeClock();

    const { client, transport } = await connectMock(clock, {
      onTransportDrop() {
        transportDropCount++;
      },
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

    // Advance virtual time to ensure no spurious second call.
    await clock.advance(50);

    expect(transportDropCount).toBe(1);
    expect(disconnectCount).toBe(1);
  });
});
