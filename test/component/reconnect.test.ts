/**
 * Component tests — reconnect behaviour.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import type { Frame } from "../../src/frame.js";
import { RetriesExhaustedError } from "../../src/errors.js";
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

// ── tests ───────────────────────────────────────────────────────────────────────

describe("component: reconnect", () => {
  // Scenario 3: Auto-reconnect after transport drop
  it("reconnects after transport drop and resumes sending", async () => {
    const received: Frame[] = [];
    let transportRestoreCount = 0;
    let restoredResolve: () => void = () => {};
    const restored = new Promise<void>((r) => {
      restoredResolve = r;
    });
    const clock = new FakeClock();

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
      _clock: clock,
    });

    // Send before drop — advance past drain timer (5 ms) to flush.
    testClient.send({ event: "before", payload: "drop" });
    await clock.advance(10);
    expect(t1.sent.length).toBe(1);

    // Simulate transport drop.
    t1.injectClose(1006, "");

    // Advance past the backoff delay (attempt 0, baseDelay 10 ms → ≤10 ms).
    await clock.advance(60);
    await restored;

    // Send after reconnect — goes to t2.
    testClient.send({ event: "after", payload: "reconnect" });
    await clock.advance(10);
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
    const clock = new FakeClock();

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
      _clock: clock,
    });

    // Trigger transport drop to start reconnect loop.
    t1.injectClose(1006, "");

    // Advance past both retry backoff delays (each ≤20 ms).
    await clock.advance(100);
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
    const clock = new FakeClock();

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
      _clock: clock,
    });

    // Trigger transport drop.
    // The queueMicrotask inside onTransportDrop calls close() before any
    // backoff timer fires, aborting the reconnect loop immediately.
    t1.injectClose(1006, "");

    await disconnected;

    // User-initiated close during reconnect -> onDisconnect(null).
    expect(disconnectErr).toBeNull();
  });

  // Scenario 6: close() during reconnect -> onTransportDrop fires exactly once
  it("close() during reconnect fires onTransportDrop exactly once", async () => {
    let transportDropCount = 0;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });
    const clock = new FakeClock();

    const t1 = new MockTransport();
    const dialer = new MockDialer([
      t1,
      new Error("dial fail 1"),
      new Error("dial fail 2"),
    ]);

    testClient = await connect("ws://mock/ws", {
      onTransportDrop() {
        transportDropCount++;
        // Close while the reconnect loop is active.
        queueMicrotask(() => {
          testClient?.close();
        });
      },
      onDisconnect() {
        disconnectResolve();
      },
      autoReconnect: { maxRetries: 5, baseDelay: 100, maxDelay: 500 },
      _dialer: dialer.dial,
      _clock: clock,
    });

    // Trigger transport drop -> onTransportDrop fires once with Error.
    t1.injectClose(1006, "");

    await disconnected;

    // close() during reconnect must not fire onTransportDrop a second time.
    expect(transportDropCount).toBe(1);
  });

  // Scenario 7: close() called synchronously inside onTransportDrop -> fires exactly once
  it("synchronous close() inside onTransportDrop fires onTransportDrop exactly once", async () => {
    let transportDropCount = 0;
    const clock = new FakeClock();

    const t1 = new MockTransport();
    const dialer = new MockDialer([t1]);

    testClient = await connect("ws://mock/ws", {
      onTransportDrop() {
        transportDropCount++;
        // Synchronous close() inside the callback — reconnecting is not yet
        // set when this fires, so the bug would double-fire onTransportDrop.
        testClient?.close();
      },
      autoReconnect: { maxRetries: 5, baseDelay: 100, maxDelay: 500 },
      _dialer: dialer.dial,
      _clock: clock,
    });

    t1.injectClose(1006, "");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await testClient!.done;

    expect(transportDropCount).toBe(1);
  });

  // Scenario 8: close() after successful reconnect fires onTransportDrop(null)
  it("close() after successful reconnect fires onTransportDrop(null)", async () => {
    const drops: (Error | null)[] = [];
    let restoredResolve: () => void = () => {};
    const restored = new Promise<void>((r) => {
      restoredResolve = r;
    });
    const clock = new FakeClock();

    const t1 = new MockTransport();
    const t2 = new MockTransport();
    const dialer = new MockDialer([t1, t2]);

    testClient = await connect("ws://mock/ws", {
      onTransportDrop(err) {
        drops.push(err);
      },
      onTransportRestore() {
        restoredResolve();
      },
      autoReconnect: { maxRetries: 5, baseDelay: 10, maxDelay: 50 },
      _dialer: dialer.dial,
      _clock: clock,
    });

    // Drop first transport — reconnecting flag set.
    t1.injectClose(1006, "");
    await clock.advance(60);
    await restored;

    // Now connected on t2. reconnecting should be false again.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    testClient!.close();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await testClient!.done;

    // First drop: Error. Clean close after reconnect: null.
    expect(drops).toHaveLength(2);
    expect(drops[0]).toBeInstanceOf(Error);
    expect(drops[1]).toBeNull();
  });

  // Scenario 9: throwing onTransportDrop does not prevent onDisconnect or done
  it("throwing onTransportDrop does not hang the client", async () => {
    let disconnectFired = false;

    const t1 = new MockTransport();
    const dialer = new MockDialer([t1]);

    testClient = await connect("ws://mock/ws", {
      onTransportDrop() {
        throw new Error("callback error");
      },
      onDisconnect() {
        disconnectFired = true;
      },
      _dialer: dialer.dial,
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    testClient!.close();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await testClient!.done;

    expect(disconnectFired).toBe(true);
  });

  // Scenario 10: no autoReconnect + close() inside onTransportDrop fires onTransportDrop exactly once
  it("no autoReconnect: close() inside onTransportDrop does not double-fire", async () => {
    const drops: (Error | null)[] = [];

    const t1 = new MockTransport();
    const dialer = new MockDialer([t1]);

    testClient = await connect("ws://mock/ws", {
      onTransportDrop(err) {
        drops.push(err);
        // Synchronous close() — must not trigger onTransportDrop(null) again.
        testClient?.close();
      },
      _dialer: dialer.dial,
    });

    t1.injectClose(1006, "");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await testClient!.done;

    expect(drops).toHaveLength(1);
    expect(drops[0]).toBeInstanceOf(Error);
  });
});
