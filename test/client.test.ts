import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { connect } from "../src/client.js";
import { ConnectionClosedError } from "../src/errors.js";
import type { Frame } from "../src/frame.js";
import type { Client } from "../src/client.js";

// ── test helpers ────────────────────────────────────────────────────────────────

/** Start an echo WebSocket server on a random port and return it with the URL. */
function createEchoServer(): { server: WebSocketServer; url: string } {
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      // Echo back as text frame to match the original JSON string.
      ws.send(isBinary ? data : data.toString(), { binary: false });
    });
  });
  const addr = server.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("unexpected address type");
  }
  return { server, url: `ws://127.0.0.1:${addr.port}` };
}

/** Wait for a specified number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── test state ──────────────────────────────────────────────────────────────────

let testServer: WebSocketServer | null = null;
let testClient: Client | null = null;

afterEach(async () => {
  // Clean up client.
  if (testClient) {
    testClient.close();
    await testClient.done;
    testClient = null;
  }
  // Clean up server.
  if (testServer) {
    await new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by if
      testServer!.close(() => resolve());
    });
    testServer = null;
  }
});

// ── tests ───────────────────────────────────────────────────────────────────────

describe("client lifecycle", () => {
  it("connects, sends, receives echo, and closes cleanly", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    const received: Frame[] = [];
    let disconnectErr: Error | null | undefined;

    testClient = await connect(url, {
      onMessage: (frame) => received.push(frame),
      onDisconnect: (err) => {
        disconnectErr = err;
      },
    });

    testClient.send({ event: "msg", payload: "hello" });
    await delay(50);

    expect(received.length).toBe(1);
    expect(received[0].event).toBe("msg");
    expect(received[0].payload).toBe("hello");

    testClient.close();
    await testClient.done;

    // onDisconnect fires with null for clean close.
    expect(disconnectErr).toBeNull();
  });

  it("done resolves after close()", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    testClient = await connect(url);
    const donePromise = testClient.done;
    testClient.close();
    await donePromise;
    // If we reach here, done resolved — test passes.
  });

  it("close() is idempotent", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    let disconnectCount = 0;
    testClient = await connect(url, {
      onDisconnect: () => {
        disconnectCount++;
      },
    });

    testClient.close();
    testClient.close();
    testClient.close();
    await testClient.done;

    expect(disconnectCount).toBe(1);
  });
});

describe("send after close", () => {
  it("throws ConnectionClosedError", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    testClient = await connect(url);
    testClient.close();
    await testClient.done;

    expect(() => testClient?.send({ event: "test" })).toThrow(
      ConnectionClosedError,
    );
  });
});

describe("server-side drop (no auto-reconnect)", () => {
  it("fires onTransportDrop then onDisconnect with ConnectionLostError", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    let transportDropped = false;
    let disconnectErr: Error | null | undefined;

    testClient = await connect(url, {
      onTransportDrop: () => {
        transportDropped = true;
      },
      onDisconnect: (err) => {
        disconnectErr = err;
      },
    });

    // Force server to close all connections.
    for (const ws of server.clients) {
      ws.close();
    }

    await testClient.done;

    expect(transportDropped).toBe(true);
    expect(disconnectErr).toBeDefined();
    expect((disconnectErr as Error).name).toBe("ConnectionLostError");
  });
});

describe("auto-reconnect", () => {
  it("reconnects after server drop and resumes message flow", async () => {
    const { server, url } = createEchoServer();
    testServer = server;
    const port = new URL(url).port;

    const received: Frame[] = [];
    const reconnectAttempts: number[] = [];
    let transportDropCount = 0;

    testClient = await connect(url, {
      onMessage: (frame) => received.push(frame),
      onReconnect: (attempt) => reconnectAttempts.push(attempt),
      onTransportDrop: () => {
        transportDropCount++;
      },
      autoReconnect: { maxRetries: 5, baseDelay: 50, maxDelay: 200 },
    });

    // Send a message before drop.
    testClient.send({ event: "before" });
    await delay(50);
    expect(received.length).toBe(1);

    // Terminate all connections then close server, then start a new one on the same port.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const newServer = new WebSocketServer({ port: Number(port) });
    newServer.on("connection", (ws) => {
      ws.on("message", (data, isBinary) =>
        ws.send(isBinary ? data : data.toString(), { binary: false }),
      );
    });
    testServer = newServer;

    // Wait for reconnection.
    await delay(500);

    expect(transportDropCount).toBeGreaterThanOrEqual(1);
    expect(reconnectAttempts.length).toBeGreaterThanOrEqual(1);

    // Send a message after reconnect.
    testClient.send({ event: "after" });
    await delay(100);

    const afterMessages = received.filter((f) => f.event === "after");
    expect(afterMessages.length).toBe(1);

    testClient.close();
    await testClient.done;
  });

  it("fires onDisconnect with RetriesExhaustedError when max retries exhausted", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    let disconnectErr: Error | null | undefined;

    testClient = await connect(url, {
      onDisconnect: (err) => {
        disconnectErr = err;
      },
      autoReconnect: { maxRetries: 2, baseDelay: 20, maxDelay: 50 },
    });

    // Kill the server permanently — terminate connections then close.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testServer = null;

    await testClient.done;

    expect(disconnectErr).toBeDefined();
    expect((disconnectErr as Error).name).toBe("RetriesExhaustedError");
  });

  it("close() during reconnect stops the loop", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    let disconnectErr: Error | null | undefined;

    testClient = await connect(url, {
      onDisconnect: (err) => {
        disconnectErr = err;
      },
      autoReconnect: { maxRetries: 10, baseDelay: 200, maxDelay: 1000 },
    });

    // Kill the server permanently — terminate connections then close.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testServer = null;

    // Wait a moment for the reconnect loop to start, then close.
    await delay(100);
    testClient.close();
    await testClient.done;

    // onDisconnect should fire with null (clean close wins).
    expect(disconnectErr).toBeNull();
  });
});

describe("send buffer head-drop", () => {
  it("drops oldest frame when buffer is full", async () => {
    const { server } = createEchoServer();
    testServer = server;

    // Temporarily stop the echo server from accepting so buffer fills up.
    // Use a custom server that doesn't echo — just accepts.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const silentServer = new WebSocketServer({ port: 0 });
    silentServer.on("connection", () => {
      // Accept but don't echo — let send buffer fill.
    });
    testServer = silentServer;

    const addr = silentServer.address();
    if (typeof addr === "string" || addr === null) throw new Error("bad addr");
    const silentUrl = `ws://127.0.0.1:${addr.port}`;

    testClient = await connect(silentUrl);

    // Fill beyond the 256 buffer.
    for (let i = 0; i < 300; i++) {
      testClient.send({ event: "msg", payload: i });
    }

    // Should not throw — head-drop handles overflow silently.
    // Just verify we can still send without error.
    expect(() =>
      testClient?.send({ event: "msg", payload: 300 }),
    ).not.toThrow();

    testClient.close();
    await testClient.done;
  });
});

describe("connect failure", () => {
  it("rejects when server is unreachable", async () => {
    await expect(connect("ws://127.0.0.1:19999")).rejects.toThrow(
      "wspulse: dial failed",
    );
  });
});

describe("multiple messages", () => {
  it("delivers frames in enqueue order", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    const received: Frame[] = [];
    testClient = await connect(url, {
      onMessage: (frame) => received.push(frame),
    });

    for (let i = 0; i < 10; i++) {
      testClient.send({ event: "seq", payload: i });
    }

    await delay(200);

    expect(received.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(received[i].payload).toBe(i);
    }

    testClient.close();
    await testClient.done;
  });
});
