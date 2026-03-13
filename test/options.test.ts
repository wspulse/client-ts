import { describe, it, expect, vi } from "vitest";
import { resolveOptions } from "../src/options.js";
import type { Frame } from "../src/frame.js";

describe("resolveOptions", () => {
  it("returns defaults when no options provided", () => {
    const opts = resolveOptions();
    expect(opts.writeWait).toBe(10_000);
    expect(opts.maxMessageSize).toBe(1 << 20);
    expect(opts.heartbeat.pingPeriod).toBe(20_000);
    expect(opts.heartbeat.pongWait).toBe(60_000);
    expect(opts.autoReconnect).toBeUndefined();
    expect(opts.dialHeaders).toEqual({});
  });

  it("preserves user-provided values", () => {
    const opts = resolveOptions({
      writeWait: 5000,
      maxMessageSize: 2048,
      autoReconnect: { maxRetries: 3, baseDelay: 100, maxDelay: 5000 },
      dialHeaders: { Authorization: "Bearer token" },
    });
    expect(opts.writeWait).toBe(5000);
    expect(opts.maxMessageSize).toBe(2048);
    expect(opts.autoReconnect?.maxRetries).toBe(3);
    expect(opts.dialHeaders.Authorization).toBe("Bearer token");
  });

  it("default callbacks are callable no-ops", () => {
    const opts = resolveOptions();
    const frame: Frame = { event: "test" };

    // These should not throw
    expect(() => opts.onMessage(frame)).not.toThrow();
    expect(() => opts.onDisconnect(null)).not.toThrow();
    expect(() => opts.onDisconnect(new Error("err"))).not.toThrow();
    expect(() => opts.onReconnect(0)).not.toThrow();
    expect(() => opts.onTransportDrop(new Error("drop"))).not.toThrow();
  });

  it("uses user-provided callbacks", () => {
    const onMessage = vi.fn();
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    const onTransportDrop = vi.fn();

    const opts = resolveOptions({
      onMessage,
      onDisconnect,
      onReconnect,
      onTransportDrop,
    });

    const frame: Frame = { event: "msg", payload: "hello" };
    opts.onMessage(frame);
    expect(onMessage).toHaveBeenCalledWith(frame);

    opts.onDisconnect(null);
    expect(onDisconnect).toHaveBeenCalledWith(null);

    opts.onReconnect(2);
    expect(onReconnect).toHaveBeenCalledWith(2);

    const err = new Error("transport drop");
    opts.onTransportDrop(err);
    expect(onTransportDrop).toHaveBeenCalledWith(err);
  });

  it("preserves custom heartbeat values", () => {
    const opts = resolveOptions({
      heartbeat: { pingPeriod: 10_000, pongWait: 30_000 },
    });
    expect(opts.heartbeat.pingPeriod).toBe(10_000);
    expect(opts.heartbeat.pongWait).toBe(30_000);
  });

  it("handles empty options object", () => {
    const opts = resolveOptions({});
    expect(opts.writeWait).toBe(10_000);
    expect(opts.maxMessageSize).toBe(1 << 20);
    expect(opts.autoReconnect).toBeUndefined();
  });
});
