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
import { ConnectionClosedError } from "../src/errors.js";
import type { Frame } from "../src/frame.js";
import type { Client } from "../src/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The URLs are written by global-setup.ts to a temp file (one per line).
function serverUrls(): { wsUrl: string; controlUrl: string } {
  const urlFile = path.resolve(__dirname, ".server-url");
  try {
    const lines = readFileSync(urlFile, "utf-8").trim().split("\n");
    return { wsUrl: lines[0], controlUrl: lines[1] };
  } catch {
    throw new Error(
      "integration test: .server-url not found — is global-setup running?",
    );
  }
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
});
