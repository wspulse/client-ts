/**
 * Component tests — reconnect behaviour.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import type { Frame } from "../../src/frame.js";
import { RetriesExhaustedError } from "../../src/errors.js";
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
});
