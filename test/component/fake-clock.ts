/**
 * FakeClock — deterministic timer implementation for component tests.
 *
 * Implements the {@link Clock} interface. Timers registered via
 * `setTimeout`/`setInterval` never fire automatically. Tests control
 * virtual time by calling `await advance(ms)`, which fires all callbacks
 * whose deadline falls within the advanced window (in deadline order) and
 * flushes the microtask queue after each firing so awaited Promises
 * propagate before the next timer fires.
 */
import type { Clock } from "../../src/clock.js";

interface TimerEntry {
  id: number;
  deadline: number;
  fn: () => void;
  type: "timeout" | "interval";
  interval?: number;
}

export class FakeClock implements Clock {
  private _now = 0;
  private _timers: TimerEntry[] = [];
  private _nextId = 1;

  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this._nextId++;
    this._timers.push({
      id,
      deadline: this._now + ms,
      fn,
      type: "timeout",
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    const id = handle as unknown as number;
    this._timers = this._timers.filter((t) => t.id !== id);
  }

  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = this._nextId++;
    this._timers.push({
      id,
      deadline: this._now + ms,
      fn,
      type: "interval",
      interval: ms,
    });
    return id as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(handle: ReturnType<typeof setInterval>): void {
    const id = handle as unknown as number;
    this._timers = this._timers.filter((t) => t.id !== id);
  }

  /**
   * Advance virtual time by `ms` milliseconds.
   *
   * Fires all registered callbacks whose deadline falls within the window,
   * in deadline order. Intervals are rescheduled after firing. After each
   * batch of callbacks at the same deadline, the microtask queue is flushed
   * via a real `globalThis.setTimeout(r, 0)` so that awaited Promises
   * propagate correctly before the next timer fires.
   */
  async advance(ms: number): Promise<void> {
    const target = this._now + ms;
    for (;;) {
      // Find the earliest deadline among pending timers.
      let nextDeadline = Infinity;
      for (const t of this._timers) {
        if (t.deadline < nextDeadline) {
          nextDeadline = t.deadline;
        }
      }
      if (nextDeadline > target) break;

      this._now = nextDeadline;

      // Collect all timers at this deadline.
      const toFire = this._timers.filter((t) => t.deadline <= this._now);

      // Rebuild timer list: remove timeouts, reschedule intervals.
      const remaining: TimerEntry[] = [];
      for (const t of this._timers) {
        if (t.deadline <= this._now) {
          if (t.type === "interval" && t.interval !== undefined) {
            remaining.push({ ...t, deadline: this._now + t.interval });
          }
          // timeout: drop it
        } else {
          remaining.push(t);
        }
      }
      this._timers = remaining;

      // Fire callbacks.
      for (const t of toFire) {
        t.fn();
      }

      // Flush the microtask queue so awaited Promises resolve before the
      // next timer fires. Uses globalThis.setTimeout to reach the next
      // macrotask boundary, which guarantees all queued microtasks have run.
      await new Promise<void>((r) => globalThis.setTimeout(r, 0));
    }
    this._now = target;
  }

  /** Number of pending (unfired) timer entries. */
  get pendingCount(): number {
    return this._timers.length;
  }

  /** Clear all pending timers without firing them. */
  clearAll(): void {
    this._timers = [];
  }
}
