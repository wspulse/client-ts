/**
 * Component tests — callback behaviour.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import { ConnectionLostError, ServerClosedError } from "../../src/errors.js";
import { StatusCode } from "../../src/status.js";
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

describe("component: callbacks", () => {
  // Scenario 2: Server drop -> onTransportDrop + onDisconnect (no reconnect)
  it("server drop fires onTransportDrop and onDisconnect without reconnect", async () => {
    let transportDropErr: Error | null | undefined;
    let disconnectErr: Error | null | undefined;
    const clock = new FakeClock();

    const { transport } = await connectMock(clock, {
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

  // Scenario 2b: Server close frame with code+reason -> ServerClosedError
  it("server close frame delivers ServerClosedError with code and reason", async () => {
    let transportDropErr: Error | null | undefined;
    const clock = new FakeClock();

    const { transport } = await connectMock(clock, {
      onTransportDrop(err) {
        transportDropErr = err;
      },
    });

    transport.injectClose(StatusCode.GoingAway, "server shutting down");

    expect(transportDropErr).toBeInstanceOf(ServerClosedError);
    const sce = transportDropErr as ServerClosedError;
    expect(sce.code).toBe(StatusCode.GoingAway);
    expect(sce.reason).toBe("server shutting down");
  });

  // onDisconnect fires exactly once on close
  it("onDisconnect fires exactly once on close", async () => {
    let disconnectCount = 0;
    const clock = new FakeClock();

    const { client } = await connectMock(clock, {
      onDisconnect() {
        disconnectCount++;
      },
    });

    client.close();
    await client.done;

    // Advance virtual time to ensure no spurious second call.
    await clock.advance(50);

    expect(disconnectCount).toBe(1);
  });

  // onDisconnect fires exactly once (duplicate of the earlier test but
  // with a transport drop path to ensure both clean and unclean paths
  // fire exactly once)
  it("onDisconnect fires exactly once on transport drop", async () => {
    let disconnectCount = 0;
    const clock = new FakeClock();

    const { transport } = await connectMock(clock, {
      onDisconnect() {
        disconnectCount++;
      },
    });

    transport.injectClose(1006, "");

    // Advance virtual time to ensure no spurious second call.
    await clock.advance(50);

    expect(disconnectCount).toBe(1);
  });

  // onTransportRestore does NOT fire on initial connect
  it("onTransportRestore does not fire on initial connect", async () => {
    let restoreCount = 0;
    const clock = new FakeClock();

    await connectMock(clock, {
      onTransportRestore() {
        restoreCount++;
      },
    });

    // Advance virtual time to ensure no spurious call.
    await clock.advance(50);

    expect(restoreCount).toBe(0);
  });

  // Server-initiated kick (same as transport drop detection)
  it("detects server-initiated close", async () => {
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });
    const clock = new FakeClock();

    const { transport } = await connectMock(clock, {
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

  // Clean close fires onTransportDrop(null) before onDisconnect(null)
  it("clean close fires onTransportDrop(null) before onDisconnect(null)", async () => {
    const order: string[] = [];
    const clock = new FakeClock();

    const { client } = await connectMock(clock, {
      onTransportDrop(err) {
        expect(err).toBeNull();
        order.push("onTransportDrop");
      },
      onDisconnect(err) {
        expect(err).toBeNull();
        order.push("onDisconnect");
      },
    });

    client.close();
    await client.done;

    expect(order).toEqual(["onTransportDrop", "onDisconnect"]);
  });
});
