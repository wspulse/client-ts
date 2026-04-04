/**
 * Component tests — basic connectivity and frame handling.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "../../src/client.js";
import type { Client } from "../../src/client.js";
import type { Frame } from "../../src/frame.js";
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

describe("component: basic", () => {
  // Scenario 1: Connect -> send -> receive echo -> close clean
  it("connects, sends a frame, receives echo, and closes cleanly", async () => {
    const received: Frame[] = [];
    let disconnectErr: Error | null | undefined;
    let transportDropErr: Error | null | undefined;
    const clock = new FakeClock();

    const { client, transport } = await connectMock(clock, {
      onMessage(frame) {
        received.push(frame);
      },
      onDisconnect(err) {
        disconnectErr = err;
      },
      onTransportDrop(err) {
        transportDropErr = err;
      },
    });

    client.send({ event: "msg", payload: { text: "hello" } });

    // Advance past the drain timer (5 ms) to flush the send buffer.
    await clock.advance(10);

    // Verify sent data.
    expect(transport.sent.length).toBe(1);
    const sentFrame = JSON.parse(transport.sent[0] as string) as Frame;
    expect(sentFrame.event).toBe("msg");
    expect(sentFrame.payload).toEqual({ text: "hello" });

    // Simulate echo from server.
    transport.injectMessage(transport.sent[0] as string);

    expect(received.length).toBe(1);
    expect(received[0]?.event).toBe("msg");
    expect(received[0]?.payload).toEqual({ text: "hello" });

    client.close();
    await client.done;

    expect(transportDropErr).toBeNull();
    expect(disconnectErr).toBeNull();
  });

  // Frame field round-trip
  it("round-trips all Frame fields (event, payload)", async () => {
    const received: Frame[] = [];
    const clock = new FakeClock();

    const { client, transport } = await connectMock(clock, {
      onMessage(frame) {
        received.push(frame);
      },
    });

    const outbound: Frame = {
      event: "chat.message",
      payload: { user: "alice", text: "hi", n: 42, nested: { ok: true } },
    };
    client.send(outbound);

    // Advance past the drain timer.
    await clock.advance(10);

    // Echo back.
    transport.injectMessage(transport.sent[0] as string);

    expect(received[0]).toEqual(outbound);
  });

  // Server rejection (dial failure)
  it("handles dial failure gracefully", async () => {
    const dialer = new MockDialer([new Error("connection refused")]);

    await expect(
      connect("ws://mock/ws", {
        _dialer: dialer.dial,
        _clock: new FakeClock(),
      }),
    ).rejects.toThrow("connection refused");
  });

  // Message ordering
  it("sends multiple frames and receives them in order", async () => {
    const received: Frame[] = [];
    const clock = new FakeClock();

    const { client, transport } = await connectMock(clock, {
      onMessage(frame) {
        received.push(frame);
      },
    });

    const count = 10;
    for (let i = 0; i < count; i++) {
      client.send({ event: "seq", payload: { i } });
    }

    // Advance past the drain timer.
    await clock.advance(10);

    expect(transport.sent.length).toBe(count);

    // Echo all back in order.
    for (let i = 0; i < count; i++) {
      transport.injectMessage(transport.sent[i] as string);
    }

    expect(received.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(received[i]?.event).toBe("seq");
      expect(received[i]?.payload).toEqual({ i });
    }
  });

  // Verify room-like query params pass through (URL is just forwarded
  // to the dialer, so we verify the dialer receives the full URL)
  it("passes URL with query params to dialer", async () => {
    let dialedUrl = "";
    const t = new MockTransport();
    const clock = new FakeClock();

    testClient = await connect("ws://mock/ws?room=myroom", {
      _dialer: async (url) => {
        dialedUrl = url;
        return t;
      },
      _clock: clock,
    });

    expect(dialedUrl).toBe("ws://mock/ws?room=myroom");
  });
});
