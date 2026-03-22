import { describe, it, expect } from "vitest";
import {
  ConnectionClosedError,
  RetriesExhaustedError,
  ConnectionLostError,
  SendBufferFullError,
} from "../src/errors.js";

describe("error classes", () => {
  it("ConnectionClosedError has correct name and message", () => {
    const err = new ConnectionClosedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectionClosedError);
    expect(err.name).toBe("ConnectionClosedError");
    expect(err.message).toContain("closed");
  });

  it("RetriesExhaustedError has correct name and message", () => {
    const err = new RetriesExhaustedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RetriesExhaustedError);
    expect(err.name).toBe("RetriesExhaustedError");
    expect(err.message).toContain("retries");
  });

  it("ConnectionLostError has correct name and message", () => {
    const err = new ConnectionLostError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(err.name).toBe("ConnectionLostError");
    expect(err.message).toContain("lost");
  });

  it("SendBufferFullError has correct name and message", () => {
    const err = new SendBufferFullError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SendBufferFullError);
    expect(err.name).toBe("SendBufferFullError");
    expect(err.message).toContain("buffer");
  });
});
