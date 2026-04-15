/**
 * Timer abstraction for testability.
 *
 * @internal Test-injection only. Not exported from the public API.
 */
export interface Clock {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

/** @internal Default clock backed by the global timer functions. */
export const defaultClock: Clock = {
  setTimeout,
  clearTimeout,
};
