/**
 * Mock WebSocket transport for component tests.
 *
 * Zero network I/O, fully deterministic. Implements the {@link Transport}
 * interface with helpers to inject messages, close events, and errors.
 */
import type { Transport } from "../../src/transport.js";
import type { ResolvedOptions } from "../../src/options.js";

/** WebSocket readyState constants. */
const WS_OPEN = 1;
const WS_CLOSED = 3;

/**
 * Mock transport that satisfies the {@link Transport} interface.
 *
 * Test code drives behaviour via `injectMessage()`, `injectClose()`,
 * `injectError()`, and `suppressPongs()`. Sent data is captured in
 * the `sent` array for assertions.
 */
export class MockTransport implements Transport {
  readyState: number = WS_OPEN;

  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;

  /** All data passed to `send()`, in order. */
  sent: Array<string | ArrayBuffer | Uint8Array | Blob> = [];

  /** Event listeners registered via `on()` (Node.js ws-style). */
  private eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  /** When true, `ping()` does not trigger pong handlers. */
  private pongsDisabled = false;

  // ── Transport interface ─────────────────────────────────────────────────

  send(data: string | ArrayBuffer | Uint8Array | Blob): void {
    if (this.readyState !== WS_OPEN) {
      throw new Error("MockTransport: send on non-open socket");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.eventListeners.get(event)?.delete(listener);
  }

  ping(_data?: unknown, _mask?: boolean, cb?: (err?: Error) => void): void {
    cb?.();
    if (!this.pongsDisabled) {
      // Simulate pong arriving after a microtask (network round-trip).
      queueMicrotask(() => {
        this.eventListeners.get("pong")?.forEach((h) => h());
      });
    }
  }

  terminate(): void {
    this.close(1001, "terminated");
  }

  // ── Test helpers ───────────────────────────────────────────────────────

  /** Deliver a message to the client's onmessage handler. */
  injectMessage(data: string): void {
    this.onmessage?.({ data });
  }

  /** Simulate transport close (server drop). */
  injectClose(code = 1006, reason = ""): void {
    this.readyState = WS_CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Simulate a transport error. */
  injectError(): void {
    this.onerror?.({});
  }

  /** Stop responding to pings (simulates pong timeout). */
  suppressPongs(): void {
    this.pongsDisabled = true;
  }
}

/**
 * Pre-configured dialer that returns mock transports in sequence.
 *
 * Each call to `dial()` returns the next result from the constructor
 * array. If the result is an `Error`, the dial rejects. If it is a
 * `MockTransport`, the dial resolves with it.
 *
 * Used for reconnect tests: the first transport represents the initial
 * connection; subsequent transports (or errors) represent reconnect
 * attempts.
 */
export class MockDialer {
  private results: Array<MockTransport | Error>;
  private index = 0;

  constructor(results: Array<MockTransport | Error>) {
    this.results = results;
  }

  /** Bind-safe dial function — pass `dialer.dial` directly. */
  dial = async (_url: string, _opts: ResolvedOptions): Promise<Transport> => {
    if (this.index >= this.results.length) {
      throw new Error(
        `MockDialer: no more results (called ${this.index + 1} times, have ${this.results.length})`,
      );
    }
    const result = this.results[this.index++];
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  /** Number of times `dial()` has been called. */
  get dialCount(): number {
    return this.index;
  }
}
