/**
 * Component tests — callback behaviour.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import { ConnectionLostError } from "../../src/errors.js";
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

describe("component: callbacks", () => {
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
});
