import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  // ── A: construction ────────────────────────────────────────────────

  it("A1: starts empty with correct capacity", () => {
    const rb = new RingBuffer<number>(4);
    expect(rb.length).toBe(0);
    // Verify capacity is honoured: push 4 succeeds, push 5 fails.
    expect(rb.push(1)).toBe(true);
    expect(rb.push(2)).toBe(true);
    expect(rb.push(3)).toBe(true);
    expect(rb.push(4)).toBe(true);
    expect(rb.push(5)).toBe(false);
    expect(rb.length).toBe(4);
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

  // ── C: peek ────────────────────────────────────────────────────────

  it("C1: peek returns front without removing", () => {
    const rb = new RingBuffer<string>(3);
    rb.push("a");
    rb.push("b");
    expect(rb.peek()).toBe("a");
    expect(rb.length).toBe(2);
    expect(rb.peek()).toBe("a"); // idempotent
  });

  it("C2: peek returns undefined when empty", () => {
    const rb = new RingBuffer<number>(2);
    expect(rb.peek()).toBeUndefined();
  });

  // ── D: shift ───────────────────────────────────────────────────────

  it("D1: shift returns elements in FIFO order", () => {
    const rb = new RingBuffer<string>(3);
    rb.push("a");
    rb.push("b");
    rb.push("c");
    expect(rb.shift()).toBe("a");
    expect(rb.shift()).toBe("b");
    expect(rb.shift()).toBe("c");
    expect(rb.length).toBe(0);
  });

  it("D2: shift returns undefined when empty", () => {
    const rb = new RingBuffer<number>(2);
    expect(rb.shift()).toBeUndefined();
  });

  // ── E: wrap-around ─────────────────────────────────────────────────

  it("E1: push and shift wrap around correctly", () => {
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

  it("E2: multiple wrap-around cycles", () => {
    const rb = new RingBuffer<number>(2);
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(rb.push(cycle * 2)).toBe(true);
      expect(rb.push(cycle * 2 + 1)).toBe(true);
      expect(rb.shift()).toBe(cycle * 2);
      expect(rb.shift()).toBe(cycle * 2 + 1);
      expect(rb.length).toBe(0);
    }
  });

  it("E3: push rejects when full after partial drain and refill", () => {
    const rb = new RingBuffer<string>(3);
    // Fill
    rb.push("a");
    rb.push("b");
    rb.push("c");
    // Drain 2
    rb.shift();
    rb.shift();
    // Refill to capacity (wraps around)
    expect(rb.push("d")).toBe(true);
    expect(rb.push("e")).toBe(true);
    // Now full — must reject
    expect(rb.push("f")).toBe(false);
    expect(rb.length).toBe(3);
    // Verify FIFO
    expect(rb.shift()).toBe("c");
    expect(rb.shift()).toBe("d");
    expect(rb.shift()).toBe("e");
  });

  // ── F: clear ───────────────────────────────────────────────────────

  it("F1: clear resets buffer to empty", () => {
    const rb = new RingBuffer<string>(3);
    rb.push("a");
    rb.push("b");
    rb.push("c");
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.shift()).toBeUndefined();
  });

  it("F2: buffer is usable after clear", () => {
    const rb = new RingBuffer<string>(2);
    rb.push("a");
    rb.push("b");
    rb.clear();
    expect(rb.push("c")).toBe(true);
    expect(rb.push("d")).toBe(true);
    expect(rb.shift()).toBe("c");
    expect(rb.shift()).toBe("d");
  });

  it("F3: clear with non-zero head", () => {
    const rb = new RingBuffer<string>(3);
    rb.push("a");
    rb.push("b");
    rb.push("c");
    // Advance head past index 0
    rb.shift(); // head=1
    rb.shift(); // head=2
    // Push more to wrap
    rb.push("d");
    rb.push("e");
    // Now head=2, size=3 — clear must handle wrapped state
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.shift()).toBeUndefined();
    // Buffer must be fully usable after clear
    expect(rb.push("f")).toBe(true);
    expect(rb.push("g")).toBe(true);
    expect(rb.push("h")).toBe(true);
    expect(rb.shift()).toBe("f");
    expect(rb.shift()).toBe("g");
    expect(rb.shift()).toBe("h");
  });

  // ── G: capacity 1 ─────────────────────────────────────────────────

  it("G1: works with capacity 1", () => {
    const rb = new RingBuffer<string>(1);
    expect(rb.push("a")).toBe(true);
    expect(rb.push("b")).toBe(false);
    expect(rb.shift()).toBe("a");
    expect(rb.push("b")).toBe(true);
    expect(rb.shift()).toBe("b");
    expect(rb.length).toBe(0);
  });
});
