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
}

export class FakeClock implements Clock {
  private _now = 0;
  private _timers: TimerEntry[] = [];
  private _nextId = 1;
  private _clearedIds = new Set<number>();

  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this._nextId++;
    this._timers.push({ id, deadline: this._now + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    const id = handle as unknown as number;
    this._timers = this._timers.filter((t) => t.id !== id);
    this._clearedIds.add(id);
  }

  /**
   * Advance virtual time by `ms` milliseconds.
   *
   * Fires all registered callbacks whose deadline falls within the window,
   * in deadline order. Intervals are rescheduled after firing. If a callback
   * clears another timer at the same deadline, the cleared timer is skipped.
   * After each batch, the microtask queue is flushed so that awaited Promises
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

      // Remove fired timers.
      this._timers = this._timers.filter((t) => t.deadline > this._now);

      // Fire callbacks. A prior callback may clear a later timer at the same
      // deadline via clearTimeout/clearInterval — skip it if its ID was cleared.
      this._clearedIds.clear();
      for (const t of toFire) {
        if (this._clearedIds.has(t.id)) continue;
        t.fn();
      }

      // Flush the microtask queue so awaited Promises resolve before the
      // next timer fires. A single yield is not enough when the consumer
      // chains multiple awaits (e.g., reconnect -> dial -> reschedule),
      // so we yield several times to let deep promise chains settle.
      for (let i = 0; i < 10; i++) await Promise.resolve();
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
