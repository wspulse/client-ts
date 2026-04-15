import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { connect } from "../src/client.js";
import { ConnectionClosedError, SendBufferFullError } from "../src/errors.js";
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

    await vi.waitFor(() => {
      expect(received.length).toBe(1);
      expect(received[0].event).toBe("msg");
      expect(received[0].payload).toBe("hello");
    });

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
    let transportDropCount = 0;
    let transportRestoreCount = 0;

    testClient = await connect(url, {
      onMessage: (frame) => received.push(frame),
      onTransportRestore: () => {
        transportRestoreCount++;
      },
      onTransportDrop: () => {
        transportDropCount++;
      },
      autoReconnect: { maxRetries: 5, baseDelay: 50, maxDelay: 200 },
    });

    // Send a message before drop.
    testClient.send({ event: "before" });
    await vi.waitFor(() => expect(received.length).toBe(1));

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
    await vi.waitFor(() => {
      expect(transportDropCount).toBeGreaterThanOrEqual(1);
      expect(transportRestoreCount).toBeGreaterThanOrEqual(1);
    });

    // Send a message after reconnect.
    testClient.send({ event: "after" });
    await vi.waitFor(() =>
      expect(received.filter((f) => f.event === "after").length).toBe(1),
    );

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
    let transportDropped = false;

    testClient = await connect(url, {
      onDisconnect: (err) => {
        disconnectErr = err;
      },
      onTransportDrop: () => {
        transportDropped = true;
      },
      autoReconnect: { maxRetries: 10, baseDelay: 200, maxDelay: 1000 },
    });

    // Kill the server permanently — terminate connections then close.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testServer = null;

    // Wait for the transport drop (reconnect loop has started), then close.
    await vi.waitFor(() => expect(transportDropped).toBe(true));
    testClient.close();
    await testClient.done;

    // onDisconnect should fire with null (clean close wins).
    expect(disconnectErr).toBeNull();
  });
});

describe("send buffer overflow", () => {
  it("throws SendBufferFullError when buffer is full", async () => {
    const { server } = createEchoServer();
    testServer = server;

    // Use a server that accepts but doesn't echo — let send buffer fill.
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

    // Fill up the 256-frame buffer — should not throw.
    for (let i = 0; i < 256; i++) {
      testClient.send({ event: "msg", payload: i });
    }

    // The 257th send must throw SendBufferFullError.
    expect(() => testClient?.send({ event: "msg", payload: 256 })).toThrow(
      SendBufferFullError,
    );

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

describe("connect failure with autoReconnect", () => {
  it("rejects even when autoReconnect is enabled", async () => {
    await expect(
      connect("ws://127.0.0.1:19999", {
        autoReconnect: { maxRetries: 5, baseDelay: 5, maxDelay: 5 },
      }),
    ).rejects.toThrow("wspulse: dial failed");
  });

  it("does not fire any callbacks on initial dial failure", async () => {
    const onTransportDrop = vi.fn();
    const onDisconnect = vi.fn();
    const onTransportRestore = vi.fn();

    await expect(
      connect("ws://127.0.0.1:19999", {
        onTransportDrop,
        onDisconnect,
        onTransportRestore,
        autoReconnect: { maxRetries: 5, baseDelay: 5, maxDelay: 5 },
      }),
    ).rejects.toThrow("wspulse: dial failed");

    expect(onTransportDrop).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onTransportRestore).not.toHaveBeenCalled();
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

    await vi.waitFor(() => expect(received.length).toBe(10));

    expect(received.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(received[i].payload).toBe(i);
    }

    testClient.close();
    await testClient.done;
  });
});

describe("maxMessageSize", () => {
  it("closes connection when inbound message exceeds limit", async () => {
    // Server that sends an oversized message shortly after connect.
    const bigServer = new WebSocketServer({ port: 0 });
    bigServer.on("connection", (ws) => {
      // Small delay ensures client has attached onmessage handler.
      setTimeout(() => {
        const oversized = JSON.stringify({
          event: "big",
          payload: "x".repeat(200),
        });
        ws.send(oversized, { binary: false });
      }, 20);
    });
    const addr = bigServer.address();
    if (typeof addr === "string" || addr === null) throw new Error("bad addr");
    testServer = bigServer;

    const received: Frame[] = [];
    let disconnectErr: Error | null | undefined;

    testClient = await connect(`ws://127.0.0.1:${addr.port}`, {
      maxMessageSize: 100,
      onMessage: (frame) => received.push(frame),
      onDisconnect: (err) => {
        disconnectErr = err;
      },
    });

    await testClient.done;

    // Oversized message should not be delivered.
    expect(received.length).toBe(0);
    // Connection should be closed (ConnectionLostError since no auto-reconnect).
    expect(disconnectErr).toBeDefined();
  });
});

describe("decode failure", () => {
  it("logs warning and continues processing valid frames", async () => {
    // Server that sends an invalid frame followed by a valid one.
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (ws) => {
      setTimeout(() => {
        ws.send("not valid json", { binary: false });
        ws.send(JSON.stringify({ event: "valid" }), { binary: false });
      }, 20);
    });
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("bad addr");

    const received: Frame[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    testClient = await connect(`ws://127.0.0.1:${addr.port}`, {
      onMessage: (frame) => received.push(frame),
    });
    testServer = server;

    // Wait for the valid frame to arrive.
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000 });

    expect(received[0].event).toBe("valid");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("wspulse/client:"),
      expect.anything(),
    );

    warnSpy.mockRestore();
    testClient.close();
    await testClient.done;
  });
});

describe("concurrent close and transport drop", () => {
  it("fires onDisconnect exactly once", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    let disconnectCount = 0;

    testClient = await connect(url, {
      onDisconnect: () => {
        disconnectCount++;
      },
      onTransportDrop: () => {
        // Call close() simultaneously with transport drop.
        testClient?.close();
      },
    });

    // Kill all connections from server side.
    for (const ws of server.clients) ws.terminate();

    await testClient.done;

    // Regardless of the race, onDisconnect must fire exactly once.
    expect(disconnectCount).toBe(1);
  });
});

describe("dialHeaders", () => {
  it("sends custom headers during handshake", async () => {
    let receivedHeaders: Record<string, string> = {};
    const server = new WebSocketServer({ port: 0 });
    server.on("headers", (_headers, req) => {
      receivedHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
    });
    server.on("connection", (ws) => {
      ws.on("message", (data, isBinary) => {
        ws.send(isBinary ? data : data.toString(), { binary: false });
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("bad addr");
    testServer = server;

    testClient = await connect(`ws://127.0.0.1:${addr.port}`, {
      dialHeaders: { "X-Custom-Token": "test-value-123" },
    });

    expect(receivedHeaders["x-custom-token"]).toBe("test-value-123");

    testClient.close();
    await testClient.done;
  });
});

describe("onMessage must not fire after onDisconnect", () => {
  it("drops messages that arrive during shutdown", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    const callOrder: string[] = [];
    let disconnectFired = false;

    testClient = await connect(url, {
      onMessage: () => {
        callOrder.push("message");
        if (disconnectFired) {
          throw new Error("onMessage fired after onDisconnect");
        }
      },
      onDisconnect: () => {
        disconnectFired = true;
        callOrder.push("disconnect");
      },
    });

    // Send some data then close — after close, no onMessage should fire.
    testClient.send({ event: "msg" });
    await vi.waitFor(() => expect(callOrder).toContain("message"));

    testClient.close();
    await testClient.done;

    // Verify onDisconnect is the last callback that fired.
    expect(callOrder[callOrder.length - 1]).toBe("disconnect");
  });
});

describe("onTransportRestore", () => {
  it("fires after successful reconnect", async () => {
    const { server, url } = createEchoServer();
    testServer = server;
    const port = new URL(url).port;

    let transportRestoreCount = 0;
    let transportRestoreResolve: () => void = () => {};
    const transportRestored = new Promise<void>((r) => {
      transportRestoreResolve = r;
    });

    testClient = await connect(url, {
      onTransportRestore: () => {
        transportRestoreCount++;
        transportRestoreResolve();
      },
      autoReconnect: { maxRetries: 5, baseDelay: 50, maxDelay: 200 },
    });

    // Terminate all connections then restart on same port.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const newServer = new WebSocketServer({ port: Number(port) });
    newServer.on("connection", (ws) => {
      ws.on("message", (data, isBinary) =>
        ws.send(isBinary ? data : data.toString(), { binary: false }),
      );
    });
    testServer = newServer;

    await transportRestored;
    expect(transportRestoreCount).toBe(1);

    testClient.close();
    await testClient.done;
  });

  it("throwing callback does not leak connection or trigger retry", async () => {
    const { server, url } = createEchoServer();
    testServer = server;
    const port = new URL(url).port;

    const received: Frame[] = [];
    let transportDropCount = 0;
    let transportRestoreCount = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let restoreResolve: () => void = () => {};
    const restored = new Promise<void>((r) => {
      restoreResolve = r;
    });

    testClient = await connect(url, {
      onMessage: (frame) => received.push(frame),
      onTransportDrop: () => {
        transportDropCount++;
      },
      onTransportRestore: () => {
        transportRestoreCount++;
        restoreResolve();
        throw new Error("callback blew up");
      },
      autoReconnect: { maxRetries: 5, baseDelay: 50, maxDelay: 200 },
    });

    // Terminate all connections then restart on same port.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const newServer = new WebSocketServer({ port: Number(port) });
    newServer.on("connection", (ws) => {
      ws.on("message", (data, isBinary) =>
        ws.send(isBinary ? data : data.toString(), { binary: false }),
      );
    });
    testServer = newServer;

    await restored;

    // Brief wait to let any erroneous retry attempt fire.
    await new Promise((r) => setTimeout(r, 500));

    // (a) Connection is still usable — send/receive works.
    const client = testClient;
    if (!client) throw new Error("client not connected");
    client.send({ event: "after-throw", payload: "ok" });
    await vi.waitFor(() =>
      expect(received.some((f) => f.event === "after-throw")).toBe(true),
    );

    // (b) No retry was triggered — only one drop and one restore.
    expect(transportDropCount).toBe(1);
    expect(transportRestoreCount).toBe(1);

    warnSpy.mockRestore();
    testClient.close();
    await testClient.done;
  });

  it("does not fire on initial connect", async () => {
    const { server, url } = createEchoServer();
    testServer = server;

    const onTransportRestore = vi.fn();

    testClient = await connect(url, {
      onTransportRestore,
      autoReconnect: { maxRetries: 5, baseDelay: 50, maxDelay: 200 },
    });

    // Give a brief window for any erroneous call.
    await new Promise((r) => setTimeout(r, 100));

    expect(onTransportRestore).not.toHaveBeenCalled();

    testClient.close();
    await testClient.done;
  });
});
