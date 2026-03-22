import { describe, it, expect, vi } from "vitest";
import { resolveOptions } from "../src/options.js";
import { JSONCodec } from "../src/codec.js";
import type { Frame } from "../src/frame.js";

describe("resolveOptions", () => {
  it("returns defaults when no options provided", () => {
    const opts = resolveOptions();
    expect(opts.maxMessageSize).toBe(1 << 20);
    expect(opts.writeWait).toBe(10_000);
    expect(opts.heartbeat.pingPeriod).toBe(20_000);
    expect(opts.heartbeat.pongWait).toBe(60_000);
    expect(opts.autoReconnect).toBeUndefined();
    expect(opts.dialHeaders).toEqual({});
    expect(opts.codec).toBe(JSONCodec);
  });

  it("preserves user-provided values", () => {
    const opts = resolveOptions({
      maxMessageSize: 2048,
      writeWait: 5000,
      autoReconnect: { maxRetries: 3, baseDelay: 100, maxDelay: 5000 },
      dialHeaders: { Authorization: "Bearer token" },
    });
    expect(opts.maxMessageSize).toBe(2048);
    expect(opts.writeWait).toBe(5000);
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
    expect(opts.maxMessageSize).toBe(1 << 20);
    expect(opts.writeWait).toBe(10_000);
    expect(opts.autoReconnect).toBeUndefined();
  });
});

describe("resolveOptions validation", () => {
  // maxMessageSize
  it("throws on negative maxMessageSize", () => {
    expect(() => resolveOptions({ maxMessageSize: -1 })).toThrow(
      "wspulse: maxMessageSize must be non-negative",
    );
  });

  it("throws when maxMessageSize exceeds 64 MiB", () => {
    expect(() => resolveOptions({ maxMessageSize: (64 << 20) + 1 })).toThrow(
      "wspulse: maxMessageSize exceeds maximum (64 MiB)",
    );
  });

  it("allows maxMessageSize of 0", () => {
    expect(() => resolveOptions({ maxMessageSize: 0 })).not.toThrow();
  });

  // writeWait
  it("throws on zero writeWait", () => {
    expect(() => resolveOptions({ writeWait: 0 })).toThrow(
      "wspulse: writeWait must be positive",
    );
  });

  it("throws on negative writeWait", () => {
    expect(() => resolveOptions({ writeWait: -1 })).toThrow(
      "wspulse: writeWait must be positive",
    );
  });

  it("throws when writeWait exceeds 30s", () => {
    expect(() => resolveOptions({ writeWait: 31_000 })).toThrow(
      "wspulse: writeWait exceeds maximum (30s)",
    );
  });

  // heartbeat.pingPeriod
  it("throws on zero pingPeriod", () => {
    expect(() =>
      resolveOptions({ heartbeat: { pingPeriod: 0, pongWait: 60_000 } }),
    ).toThrow("wspulse: heartbeat.pingPeriod must be positive");
  });

  it("throws when pingPeriod exceeds 1m", () => {
    expect(() =>
      resolveOptions({ heartbeat: { pingPeriod: 61_000, pongWait: 120_000 } }),
    ).toThrow("wspulse: heartbeat.pingPeriod exceeds maximum (1m)");
  });

  // heartbeat.pongWait
  it("throws on zero pongWait", () => {
    expect(() =>
      resolveOptions({ heartbeat: { pingPeriod: 1_000, pongWait: 0 } }),
    ).toThrow("wspulse: heartbeat.pongWait must be positive");
  });

  it("throws when pongWait exceeds 2m", () => {
    expect(() =>
      resolveOptions({ heartbeat: { pingPeriod: 1_000, pongWait: 121_000 } }),
    ).toThrow("wspulse: heartbeat.pongWait exceeds maximum (2m)");
  });

  // heartbeat: pingPeriod < pongWait
  it("throws when pingPeriod equals pongWait", () => {
    expect(() =>
      resolveOptions({ heartbeat: { pingPeriod: 30_000, pongWait: 30_000 } }),
    ).toThrow(
      "wspulse: heartbeat.pingPeriod must be strictly less than heartbeat.pongWait",
    );
  });

  it("throws when pingPeriod exceeds pongWait", () => {
    expect(() =>
      resolveOptions({ heartbeat: { pingPeriod: 60_000, pongWait: 20_000 } }),
    ).toThrow(
      "wspulse: heartbeat.pingPeriod must be strictly less than heartbeat.pongWait",
    );
  });

  // autoReconnect.maxRetries
  it("throws on negative maxRetries", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: -1, baseDelay: 1000, maxDelay: 30_000 },
      }),
    ).toThrow("wspulse: autoReconnect.maxRetries must be non-negative");
  });

  it("throws when maxRetries exceeds 32", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: 33, baseDelay: 1000, maxDelay: 30_000 },
      }),
    ).toThrow("wspulse: autoReconnect.maxRetries exceeds maximum (32)");
  });

  it("allows maxRetries of 0 (unlimited)", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: 0, baseDelay: 1000, maxDelay: 30_000 },
      }),
    ).not.toThrow();
  });

  // autoReconnect.baseDelay
  it("throws on zero baseDelay", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: 3, baseDelay: 0, maxDelay: 30_000 },
      }),
    ).toThrow("wspulse: autoReconnect.baseDelay must be positive");
  });

  it("throws when baseDelay exceeds 1m", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: 3, baseDelay: 61_000, maxDelay: 300_000 },
      }),
    ).toThrow("wspulse: autoReconnect.baseDelay exceeds maximum (1m)");
  });

  // autoReconnect.maxDelay
  it("throws when maxDelay < baseDelay", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: 3, baseDelay: 5000, maxDelay: 1000 },
      }),
    ).toThrow("wspulse: autoReconnect.maxDelay must be >= baseDelay");
  });

  it("throws when maxDelay exceeds 5m", () => {
    expect(() =>
      resolveOptions({
        autoReconnect: { maxRetries: 3, baseDelay: 1000, maxDelay: 301_000 },
      }),
    ).toThrow("wspulse: autoReconnect.maxDelay exceeds maximum (5m)");
  });

  // valid boundary (should NOT throw)
  it("accepts max boundary values", () => {
    expect(() =>
      resolveOptions({
        maxMessageSize: 64 << 20,
        writeWait: 30_000,
        heartbeat: { pingPeriod: 59_000, pongWait: 120_000 },
        autoReconnect: {
          maxRetries: 32,
          baseDelay: 60_000,
          maxDelay: 300_000,
        },
      }),
    ).not.toThrow();
  });
});
