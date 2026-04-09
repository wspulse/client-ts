import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ring_buffer.js";

describe("RingBuffer", () => {
  // ── A: construction ────────────────────────────────────────────────

  it("A1: starts empty with correct capacity", () => {
    const rb = new RingBuffer<number>(4);
    expect(rb.length).toBe(0);
  });

  // ── B: push ────────────────────────────────────────────────────────

  it("B1: push returns true when not full", () => {
    const rb = new RingBuffer<string>(3);
    expect(rb.push("a")).toBe(true);
    expect(rb.push("b")).toBe(true);
    expect(rb.push("c")).toBe(true);
    expect(rb.length).toBe(3);
  });

  it("B2: push returns false when full", () => {
    const rb = new RingBuffer<string>(2);
    expect(rb.push("a")).toBe(true);
    expect(rb.push("b")).toBe(true);
    expect(rb.push("c")).toBe(false);
    expect(rb.length).toBe(2);
  });

  // ── C: shift ───────────────────────────────────────────────────────

  it("C1: shift returns elements in FIFO order", () => {
    const rb = new RingBuffer<string>(3);
    rb.push("a");
    rb.push("b");
    rb.push("c");
    expect(rb.shift()).toBe("a");
    expect(rb.shift()).toBe("b");
    expect(rb.shift()).toBe("c");
    expect(rb.length).toBe(0);
  });

  it("C2: shift returns undefined when empty", () => {
    const rb = new RingBuffer<number>(2);
    expect(rb.shift()).toBeUndefined();
  });

  // ── D: wrap-around ─────────────────────────────────────────────────

  it("D1: push and shift wrap around correctly", () => {
    const rb = new RingBuffer<string>(3);
    // Fill to capacity
    rb.push("a");
    rb.push("b");
    rb.push("c");
    // Dequeue two — head advances
    expect(rb.shift()).toBe("a");
    expect(rb.shift()).toBe("b");
    // Push two more — tail wraps around
    expect(rb.push("d")).toBe(true);
    expect(rb.push("e")).toBe(true);
    // Verify FIFO order after wrap
    expect(rb.shift()).toBe("c");
    expect(rb.shift()).toBe("d");
    expect(rb.shift()).toBe("e");
    expect(rb.length).toBe(0);
  });

  it("D2: multiple wrap-around cycles", () => {
    const rb = new RingBuffer<number>(2);
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(rb.push(cycle * 2)).toBe(true);
      expect(rb.push(cycle * 2 + 1)).toBe(true);
      expect(rb.shift()).toBe(cycle * 2);
      expect(rb.shift()).toBe(cycle * 2 + 1);
      expect(rb.length).toBe(0);
    }
  });

  // ── E: clear ───────────────────────────────────────────────────────

  it("E1: clear resets buffer to empty", () => {
    const rb = new RingBuffer<string>(3);
    rb.push("a");
    rb.push("b");
    rb.push("c");
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.shift()).toBeUndefined();
  });

  it("E2: buffer is usable after clear", () => {
    const rb = new RingBuffer<string>(2);
    rb.push("a");
    rb.push("b");
    rb.clear();
    expect(rb.push("c")).toBe(true);
    expect(rb.push("d")).toBe(true);
    expect(rb.shift()).toBe("c");
    expect(rb.shift()).toBe("d");
  });

  // ── F: capacity 1 ─────────────────────────────────────────────────

  it("F1: works with capacity 1", () => {
    const rb = new RingBuffer<string>(1);
    expect(rb.push("a")).toBe(true);
    expect(rb.push("b")).toBe(false);
    expect(rb.shift()).toBe("a");
    expect(rb.push("b")).toBe(true);
    expect(rb.shift()).toBe("b");
    expect(rb.length).toBe(0);
  });
});
