import { describe, it, expect } from "vitest";
import {
  connect,
  backoff,
  ConnectionClosedError,
  RetriesExhaustedError,
  ConnectionLostError,
} from "../src/index.js";

describe("index re-exports", () => {
  it("exports connect function", () => {
    expect(typeof connect).toBe("function");
  });

  it("exports backoff function", () => {
    expect(typeof backoff).toBe("function");
  });

  it("exports ConnectionClosedError", () => {
    const err = new ConnectionClosedError();
    expect(err).toBeInstanceOf(Error);
  });

  it("exports RetriesExhaustedError", () => {
    const err = new RetriesExhaustedError();
    expect(err).toBeInstanceOf(Error);
  });

  it("exports ConnectionLostError", () => {
    const err = new ConnectionLostError();
    expect(err).toBeInstanceOf(Error);
  });
});

describe("connect", () => {
  it("rejects when server is unreachable", async () => {
    await expect(connect("ws://127.0.0.1:19999")).rejects.toThrow(
      "wspulse: dial failed",
    );
  });

  it("rejects with options when server is unreachable", async () => {
    await expect(
      connect("ws://127.0.0.1:19999"),
    ).rejects.toThrow("wspulse: dial failed");
  });
});
