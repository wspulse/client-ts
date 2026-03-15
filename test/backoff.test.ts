import { describe, it, expect } from "vitest";
import { backoff } from "../src/backoff.js";

describe("backoff", () => {
  it("doubles each attempt", () => {
    const base = 100;
    const max = 10_000;
    for (let i = 0; i < 5; i++) {
      const fullDelay = base * 2 ** i;
      const half = fullDelay / 2;
      const got = backoff(i, base, max);
      expect(got).toBeGreaterThanOrEqual(half);
      expect(got).toBeLessThanOrEqual(fullDelay);
    }
  });

  it("caps at maxDelay", () => {
    const base = 1000;
    const max = 5000;
    const half = max / 2;
    const got = backoff(10, base, max);
    expect(got).toBeGreaterThanOrEqual(half);
    expect(got).toBeLessThanOrEqual(max);
  });

  it("handles attempt above 62 without overflow", () => {
    const base = 1;
    const max = 30_000;
    const half = max / 2;
    const got63 = backoff(63, base, max);
    expect(got63).toBeGreaterThanOrEqual(half);
    expect(got63).toBeLessThanOrEqual(max);
    const got100 = backoff(100, base, max);
    expect(got100).toBeGreaterThanOrEqual(half);
    expect(got100).toBeLessThanOrEqual(max);
  });

  it("returns within [base/2, base] for attempt 0", () => {
    const base = 500;
    const max = 30_000;
    const half = base / 2;
    const got = backoff(0, base, max);
    expect(got).toBeGreaterThanOrEqual(half);
    expect(got).toBeLessThanOrEqual(base);
  });
});
