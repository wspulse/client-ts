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
  it("throws not-yet-implemented error", async () => {
    await expect(connect("ws://localhost:8080")).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("throws not-yet-implemented with options", async () => {
    await expect(
      connect("ws://localhost:8080", { writeWait: 5000 }),
    ).rejects.toThrow("not yet implemented");
  });
});
