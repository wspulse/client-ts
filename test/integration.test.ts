/**
 * Integration tests — client-ts against a live wspulse/server.
 *
 * These tests validate wire protocol compatibility: JSON frame round-trip,
 * server-side ConnectFunc rejection, and echo via server OnMessage handler.
 *
 * The Go testserver is started by vitest globalSetup (test/global-setup.ts).
 * Run with: npm run test:integration (or make test-integration).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../src/client.js";
import {
  ConnectionClosedError,
  ConnectionLostError,
  RetriesExhaustedError,
} from "../src/errors.js";
import type { Frame } from "../src/frame.js";
import type { Client } from "../src/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The URLs are written by global-setup.ts to a temp file (one per line).
function serverUrls(): { wsUrl: string; controlUrl: string } {
  const urlFile = path.resolve(__dirname, ".server-url");
  let content: string;
  try {
    content = readFileSync(urlFile, "utf-8");
  } catch {
    throw new Error(
      "integration test: .server-url not found — is global-setup running?",
    );
  }
  const lines = content.trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0] || !lines[1]) {
    throw new Error(
      `integration test: .server-url invalid format — expected 2 URLs, got ${lines.length}`,
    );
  }
  return { wsUrl: lines[0], controlUrl: lines[1] };
}

function serverUrl(): string {
  return serverUrls().wsUrl;
}

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

describe("integration: wspulse/server", () => {
  it("connects, sends a frame, receives echo, and closes cleanly", async () => {
    const received: Frame[] = [];
    let disconnectErr: Error | null | undefined;

    testClient = await connect(serverUrl(), {
      onMessage(frame) {
        received.push(frame);
      },
      onDisconnect(err) {
        disconnectErr = err;
      },
    });

    testClient.send({ event: "msg", payload: { text: "hello" } });

    // Wait for echo.
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    });

    expect(received[0]?.event).toBe("msg");
    expect(received[0]?.payload).toEqual({ text: "hello" });

    testClient.close();
    await testClient.done;

    expect(disconnectErr).toBeNull();
  });

  it("round-trips all Frame fields (id, event, payload)", async () => {
    const received: Frame[] = [];

    testClient = await connect(serverUrl(), {
      onMessage(frame) {
        received.push(frame);
      },
    });

    const outbound: Frame = {
      id: "test-id-001",
      event: "chat.message",
      payload: { user: "alice", text: "hi", n: 42, nested: { ok: true } },
    };
    testClient.send(outbound);

    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    });

    expect(received[0]).toEqual(outbound);
  });

  it("handles server rejection (ConnectFunc error) gracefully", async () => {
    const url = serverUrl() + "?reject=1";

    await expect(connect(url)).rejects.toThrow();
  });

  it("sends multiple frames and receives them in order", async () => {
    const received: Frame[] = [];

    testClient = await connect(serverUrl(), {
      onMessage(frame) {
        received.push(frame);
      },
    });

    const count = 10;
    for (let i = 0; i < count; i++) {
      testClient.send({ event: "seq", payload: { i } });
    }

    await vi.waitFor(() => expect(received.length).toBe(count), {
      timeout: 5000,
    });

    for (let i = 0; i < count; i++) {
      expect(received[i]?.event).toBe("seq");
      expect(received[i]?.payload).toEqual({ i });
    }
  });

  it("send after close throws ConnectionClosedError", async () => {
    testClient = await connect(serverUrl());

    testClient.close();
    await testClient.done;

    expect(() => {
      if (!testClient) throw new Error("client was null");
      testClient.send({ event: "msg" });
    }).toThrow(ConnectionClosedError);
  });

  it("connects to a specific room via query param", async () => {
    const received: Frame[] = [];

    testClient = await connect(serverUrl() + "?room=myroom", {
      onMessage(frame) {
        received.push(frame);
      },
    });

    testClient.send({ event: "ping", payload: "pong" });

    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    });

    expect(received[0]?.event).toBe("ping");
    expect(received[0]?.payload).toBe("pong");
  });

  it("concurrent sends do not race", async () => {
    const received: Frame[] = [];

    testClient = await connect(serverUrl(), {
      onMessage(frame) {
        received.push(frame);
      },
    });

    const senders = 50;
    const msgsPerSender = 5;
    const total = senders * msgsPerSender;

    const client = testClient;
    if (!client) throw new Error("client not connected");

    await Promise.all(
      Array.from({ length: senders }, (_, s) =>
        Promise.resolve().then(() => {
          for (let m = 0; m < msgsPerSender; m++) {
            client.send({ event: "concurrent", payload: { s, m } });
          }
        }),
      ),
    );

    await vi.waitFor(() => expect(received.length).toBe(total), {
      timeout: 10000,
    });

    expect(received.every((f) => f.event === "concurrent")).toBe(true);
  });

  it("onDisconnect fires exactly once on close", async () => {
    let disconnectCount = 0;

    testClient = await connect(serverUrl(), {
      onDisconnect() {
        disconnectCount++;
      },
    });

    testClient.close();
    await testClient.done;

    // Brief window for any erroneous second call.
    await new Promise((r) => setTimeout(r, 200));

    expect(disconnectCount).toBe(1);
  });

  it("server drop fires onTransportDrop and onDisconnect without reconnect (scenario 2)", async () => {
    const connectionId = "drop-no-reconnect-ts";
    let transportDropErr: Error | undefined;
    let disconnectErr: Error | null | undefined;
    let transportDropResolve: () => void = () => {};
    const transportDropped = new Promise<void>((r) => {
      transportDropResolve = r;
    });
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    testClient = await connect(serverUrl() + `?id=${connectionId}`, {
      onTransportDrop(err) {
        transportDropErr = err;
        transportDropResolve();
      },
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
    });

    // Kick the connection — autoReconnect defaults to disabled.
    const { controlUrl } = serverUrls();
    const res = await fetch(`${controlUrl}/kick?id=${connectionId}`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);

    // Both callbacks should fire.
    await transportDropped;
    await disconnected;

    expect(transportDropErr).toBeInstanceOf(Error);
    expect(disconnectErr).toBeInstanceOf(Error);
  });

  it("close is idempotent", async () => {
    let disconnectCount = 0;

    testClient = await connect(serverUrl(), {
      onDisconnect() {
        disconnectCount++;
      },
    });

    // Call close multiple times concurrently.
    testClient.close();
    testClient.close();
    testClient.close();
    await testClient.done;

    expect(disconnectCount).toBe(1);
  });

  it("close() racing with transport drop fires onDisconnect exactly once (scenario 9)", async () => {
    const connectionId = "close-race-ts";
    let disconnectCount = 0;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    testClient = await connect(serverUrl() + `?id=${connectionId}`, {
      onDisconnect() {
        disconnectCount++;
        disconnectResolve();
      },
    });

    // Fire close() and /kick simultaneously — one triggers a transport drop
    // while the other triggers a user-initiated close.
    const { controlUrl } = serverUrls();
    const client = testClient;
    if (!client) throw new Error("client not connected");

    const [kickRes] = await Promise.all([
      fetch(`${controlUrl}/kick?id=${connectionId}`, { method: "POST" }),
      Promise.resolve().then(() => client.close()),
    ]);
    // kick may return 400 if close() won the race — that's expected.
    void kickRes;

    await disconnected;
    // Brief window for any erroneous second call.
    await new Promise((r) => setTimeout(r, 200));

    expect(disconnectCount).toBe(1);
  });

  it("detects server-initiated kick via control API", async () => {
    const connectionId = "kick-test-ts";
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    testClient = await connect(serverUrl() + `?id=${connectionId}`, {
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
    });

    // Kick the connection via control API.
    const { controlUrl } = serverUrls();
    const res = await fetch(`${controlUrl}/kick?id=${connectionId}`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);

    // Wait for onDisconnect to fire.
    await disconnected;

    // Server-initiated close → client sees an Error instance.
    expect(disconnectErr).toBeInstanceOf(Error);
  });

  it("reconnects after kick and resumes echo (scenario 3)", async () => {
    const connectionId = "reconnect-test-ts";
    const received: Frame[] = [];
    let transportRestoreCount = 0;
    let restoredResolve: () => void = () => {};
    const restored = new Promise<void>((r) => {
      restoredResolve = r;
    });

    testClient = await connect(serverUrl() + `?id=${connectionId}`, {
      onMessage(frame) {
        received.push(frame);
      },
      onTransportRestore() {
        transportRestoreCount++;
        restoredResolve();
      },
      autoReconnect: { maxRetries: 5, baseDelay: 100, maxDelay: 500 },
    });

    // Verify echo works before kick.
    testClient.send({ event: "before", payload: "kick" });
    await vi.waitFor(
      () => expect(received.some((f) => f.event === "before")).toBe(true),
      { timeout: 5000 },
    );

    // Kick the connection via control API.
    const { controlUrl } = serverUrls();
    const res = await fetch(`${controlUrl}/kick?id=${connectionId}`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);

    // Wait for transport restore after successful reconnect.
    await restored;

    // Send after reconnect — echo should still work.
    const client = testClient;
    if (!client) throw new Error("client not connected");
    client.send({ event: "after", payload: "reconnect" });

    await vi.waitFor(
      () => expect(received.some((f) => f.event === "after")).toBe(true),
      { timeout: 5000 },
    );

    expect(transportRestoreCount).toBeGreaterThanOrEqual(1);
  });

  it("fires RetriesExhaustedError after shutdown (scenario 4)", async () => {
    const connectionId = "retries-test-ts";
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    testClient = await connect(serverUrl() + `?id=${connectionId}`, {
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
      autoReconnect: { maxRetries: 2, baseDelay: 50, maxDelay: 100 },
    });

    // Shut down the WebSocket server — all reconnect dials will fail.
    const { controlUrl } = serverUrls();
    try {
      const shutRes = await fetch(`${controlUrl}/shutdown`, { method: "POST" });
      expect(shutRes.ok).toBe(true);

      // Wait for onDisconnect to fire (retries exhausted).
      await disconnected;

      expect(disconnectErr).toBeInstanceOf(RetriesExhaustedError);
    } finally {
      // Restart the server so subsequent tests can use it.
      const restartRes = await fetch(`${controlUrl}/restart`, {
        method: "POST",
      });
      expect(restartRes.ok).toBe(true);
    }
  });

  it("close() during reconnect fires onDisconnect(null) (scenario 5)", async () => {
    const connectionId = "close-reconnect-ts";
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    testClient = await connect(serverUrl() + `?id=${connectionId}`, {
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
      onTransportDrop() {
        // Close while the reconnect loop is active. Use queueMicrotask so
        // the reconnect loop has a chance to start before close() is called
        // (onTransportDrop fires before the loop begins).
        queueMicrotask(() => {
          testClient?.close();
        });
      },
      autoReconnect: { maxRetries: 10, baseDelay: 100, maxDelay: 500 },
    });

    // Kick the connection to start the reconnect loop.
    const { controlUrl } = serverUrls();
    const res = await fetch(`${controlUrl}/kick?id=${connectionId}`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);

    // Wait for onDisconnect.
    await disconnected;

    // User-initiated close during reconnect → onDisconnect(null).
    expect(disconnectErr).toBeNull();
  });

  it("pong timeout triggers ConnectionLostError (scenario 7)", async () => {
    const received: Frame[] = [];
    let disconnectErr: Error | null | undefined;
    let disconnectResolve: () => void = () => {};
    const disconnected = new Promise<void>((r) => {
      disconnectResolve = r;
    });

    // Connect with ignore_pings=1 so the server never sends Pong replies.
    // Short heartbeat so the test completes quickly.
    testClient = await connect(serverUrl() + "?ignore_pings=1", {
      onMessage: (f) => received.push(f),
      onDisconnect(err) {
        disconnectErr = err;
        disconnectResolve();
      },
      heartbeat: { pingPeriod: 100, pongWait: 300 },
    });

    // Verify the data channel works (echo).
    const client = testClient;
    if (!client) throw new Error("client not connected");
    client.send({ event: "echo", payload: "hello" });
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 5000 });
    expect(received[0]).toEqual({ event: "echo", payload: "hello" });

    // Wait for pong timeout → transport drop → ConnectionLostError.
    await disconnected;
    expect(disconnectErr).toBeInstanceOf(ConnectionLostError);
  });
});
