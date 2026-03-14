import type { Frame } from "./frame.js";
import type { ClientOptions, ResolvedOptions } from "./options.js";
import { resolveOptions } from "./options.js";
import {
  ConnectionClosedError,
  RetriesExhaustedError,
  ConnectionLostError,
} from "./errors.js";
import { backoff } from "./backoff.js";

/**
 * Public interface for the wspulse WebSocket client.
 *
 * Obtained by calling {@link connect}. All methods are safe to call
 * from any context (main thread, worker, etc.). `close()` is idempotent.
 */
export interface Client {
  /**
   * Enqueue a Frame for delivery.
   *
   * Non-blocking. If the internal send buffer is full, the **oldest** frame
   * is dropped (head-drop) to make room.
   *
   * @throws {@link ConnectionClosedError} if the client is in CLOSED state.
   */
  send(frame: Frame): void;

  /**
   * Permanently terminate the connection and stop any reconnect loop.
   *
   * Idempotent: calling more than once is safe and has no effect after the
   * first call. After `close()` returns, all internal resources (WebSocket,
   * timers) are released.
   */
  close(): void;

  /** Resolves when the client permanently disconnects. */
  readonly done: Promise<void>;
}

/** Internal send buffer capacity. Matches client-go (256). */
const SEND_BUFFER_SIZE = 256;

// ── WebSocket abstraction ─────────────────────────────────────────────────────

/**
 * Minimal WebSocket interface consumed by the client.
 *
 * Browser `WebSocket` and the `ws` package both satisfy this shape.
 * This decouples the client from any specific WebSocket implementation.
 */
interface WS {
  readonly readyState: number;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Node.js `ws` library: register event listener (ping, pong, etc.). */
  on?(event: string, listener: (...args: unknown[]) => void): void;
  /** Node.js `ws` library: send a WebSocket Ping frame. */
  ping?(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;
}

/** WebSocket readyState constants. */
const WS_OPEN = 1;

/**
 * Open a raw WebSocket connection.
 *
 * Resolves with the connected socket, or rejects on failure.
 * In Node.js, passes `dialHeaders` via the `ws` options parameter.
 */
function dialWebSocket(url: string, opts: ResolvedOptions): Promise<WS> {
  return new Promise((resolve, reject) => {
    let ws: WS;

    // Prefer 'ws' library when available (Node.js) — it supports custom
    // headers and has consistent binary/text handling across Node versions.
    // Fall back to the native browser WebSocket API.
    const hasHeaders = Object.keys(opts.dialHeaders).length > 0;
    const wsOpts: Record<string, unknown> = {};
    if (hasHeaders) wsOpts.headers = opts.dialHeaders;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const WebSocketImpl = require("ws") as {
        new (url: string, opts?: unknown): WS;
      };
      ws = new WebSocketImpl(
        url,
        Object.keys(wsOpts).length > 0 ? wsOpts : undefined,
      );
    } catch {
      // 'ws' not available — use native WebSocket (browser environment).
      if (typeof globalThis.WebSocket === "undefined") {
        reject(
          new Error(
            "wspulse: no WebSocket implementation available (install 'ws' package or run in a browser)",
          ),
        );
        return;
      }
      ws = new globalThis.WebSocket(url) as unknown as WS;
    }

    ws.onopen = () => {
      ws.onopen = null;
      ws.onerror = null;
      resolve(ws);
    };
    ws.onerror = (ev) => {
      ws.onopen = null;
      ws.onerror = null;
      reject(new Error(`wspulse: dial failed: ${String(ev)}`));
    };
  });
}

// ── Client implementation ─────────────────────────────────────────────────────

/**
 * Connect to a wspulse WebSocket server.
 *
 * The returned Promise resolves once the initial WebSocket handshake completes.
 * If the handshake fails and `autoReconnect` is not configured, the Promise
 * rejects.
 *
 * @param url  WebSocket URL (e.g. `wss://host/ws`)
 * @param opts Client options (callbacks, reconnect config, etc.)
 * @returns A connected {@link Client}
 *
 * @throws Error if the initial connection fails and autoReconnect is disabled.
 */
export async function connect(
  url: string,
  opts?: ClientOptions,
): Promise<Client> {
  const resolved = resolveOptions(opts);
  const ws = await dialWebSocket(url, resolved);
  return new WspulseClient(url, resolved, ws);
}

/**
 * Internal client implementation.
 *
 * Lifecycle states (conceptual, not exposed):
 * - CONNECTED: WebSocket is open, read loop running.
 * - RECONNECTING: transport dropped, backoff + retry in progress.
 * - CLOSED: permanently disconnected, all resources released.
 */
class WspulseClient implements Client {
  private readonly url: string;
  private readonly opts: ResolvedOptions;
  private ws: WS;

  /** Bounded send buffer with head-drop on overflow. */
  private readonly sendBuffer: string[] = [];

  /** Whether the client is permanently closed. */
  private closed = false;

  /** Fires exactly once when the client reaches CLOSED state. */
  private readonly doneResolve: () => void;

  /** Public done Promise — resolves on permanent disconnect. */
  readonly done: Promise<void>;

  /** Drain timer for flushing the send buffer. */
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  /** AbortController for cancelling the reconnect loop. */
  private abortController: AbortController;

  /** Whether onDisconnect has been called (exactly-once guard). */
  private disconnectFired = false;

  /** Pong deadline timer — fires when server stops responding. */
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ping interval timer — sends WebSocket Ping frames (Node.js only). */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string, opts: ResolvedOptions, ws: WS) {
    this.url = url;
    this.opts = opts;
    this.ws = ws;
    this.abortController = new AbortController();

    let resolve!: () => void;
    this.done = new Promise<void>((r) => {
      resolve = r;
    });
    this.doneResolve = resolve;

    this.attachListeners(ws);
    this.startDrain();
    this.startHeartbeat(ws);
  }

  /**
   * Enqueue a Frame for delivery.
   *
   * @throws {@link ConnectionClosedError} if the client is in CLOSED state.
   */
  send(frame: Frame): void {
    if (this.closed) {
      throw new ConnectionClosedError();
    }
    const data = JSON.stringify(frame);
    if (this.sendBuffer.length >= SEND_BUFFER_SIZE) {
      // Head-drop: remove oldest frame to make room.
      this.sendBuffer.shift();
    }
    this.sendBuffer.push(data);
  }

  /**
   * Permanently terminate the connection and stop any reconnect loop.
   * Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.shutdown(null);
  }

  // ── internal ──────────────────────────────────────────────────────────────

  /**
   * Attach message/close/error listeners to a WebSocket instance.
   * Called on initial connect and after each successful reconnect.
   */
  private attachListeners(ws: WS): void {
    ws.onmessage = (ev) => {
      if (this.closed || this.disconnectFired) return;

      // Decode ev.data to a string and measure its UTF-8 byte length.
      // wspulse sends JSON text frames; binary frames are decoded as UTF-8.
      const data = ev.data;
      let raw: string;
      let byteLength: number;

      if (typeof data === "string") {
        raw = data;
        byteLength =
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(raw, "utf8")
            : new TextEncoder().encode(raw).byteLength;
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
        byteLength = (data as Buffer).byteLength;
        raw = (data as Buffer).toString("utf8");
      } else if (data instanceof ArrayBuffer) {
        byteLength = data.byteLength;
        raw = new TextDecoder("utf-8").decode(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        byteLength = data.byteLength;
        raw = new TextDecoder("utf-8").decode(
          new Uint8Array(
            data.buffer as ArrayBuffer,
            data.byteOffset,
            data.byteLength,
          ),
        );
      } else {
        // Fallback for unexpected types (e.g. Blob in browsers).
        raw = String(data);
        byteLength =
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(raw, "utf8")
            : new TextEncoder().encode(raw).byteLength;
      }

      // maxMessageSize enforcement: close if exceeded (measured in bytes).
      if (
        this.opts.maxMessageSize > 0 &&
        byteLength > this.opts.maxMessageSize
      ) {
        // Detach onclose to avoid double-firing handleTransportDrop.
        ws.onclose = null;
        ws.close(1009, "message too large");
        this.handleTransportDrop();
        return;
      }

      try {
        const frame = JSON.parse(raw) as Frame;
        this.opts.onMessage(frame);
      } catch {
        // Decode error — drop frame silently (matches Go behaviour).
      }
    };

    ws.onclose = () => {
      this.handleTransportDrop();
    };

    ws.onerror = () => {
      // onerror is always followed by onclose in the WebSocket spec.
      // We handle teardown in onclose to avoid double-processing.
    };
  }

  /**
   * Handle an unexpected transport drop.
   *
   * If auto-reconnect is enabled, starts the reconnect loop.
   * Otherwise, transitions to CLOSED immediately.
   */
  private handleTransportDrop(): void {
    if (this.closed) return;

    this.stopDrain();
    this.stopHeartbeat();
    const dropErr = new Error("wspulse: transport closed unexpectedly");
    this.opts.onTransportDrop(dropErr);

    if (this.opts.autoReconnect) {
      void this.reconnectLoop();
    } else {
      this.shutdown(new ConnectionLostError());
    }
  }

  /**
   * Reconnect loop with exponential backoff.
   *
   * Runs as an async task. Stops when:
   * - A reconnect attempt succeeds.
   * - Max retries are exhausted → CLOSED with RetriesExhaustedError.
   * - `close()` is called → CLOSED with null.
   */
  private async reconnectLoop(): Promise<void> {
    // autoReconnect is guaranteed non-null here — called only from handleTransportDrop
    // when this.opts.autoReconnect is truthy.
    const rc = this.opts.autoReconnect as NonNullable<
      typeof this.opts.autoReconnect
    >;
    const signal = this.abortController.signal;
    let attempt = 0;

    while (!this.closed) {
      // Check max retries.
      if (rc.maxRetries > 0 && attempt >= rc.maxRetries) {
        this.shutdown(new RetriesExhaustedError());
        return;
      }

      // Backoff delay.
      const delay = backoff(attempt, rc.baseDelay, rc.maxDelay);
      const aborted = await this.abortableDelay(delay, signal);
      if (aborted || this.closed) return;

      // Fire onReconnect before the dial attempt.
      this.opts.onReconnect(attempt);

      // Attempt to dial.
      try {
        const newWs = await dialWebSocket(this.url, this.opts);

        // Check if close() was called during the dial.
        if (this.closed) {
          newWs.close();
          return;
        }

        // Swap connection and restart listeners + drain + heartbeat.
        this.ws = newWs;
        this.attachListeners(newWs);
        this.startDrain();
        this.startHeartbeat(newWs);
        return; // Successfully reconnected.
      } catch {
        // Dial failed — increment attempt and retry.
        attempt++;
      }
    }
  }

  /**
   * Sleep for `ms` milliseconds, but resolve early with `true` if `signal`
   * is aborted (i.e. `close()` was called).
   *
   * @returns `true` if aborted, `false` if the delay completed normally.
   */
  private abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Start the drain timer that flushes the send buffer at a fixed interval.
   *
   * The interval is short (5 ms) to keep latency low while batching in
   * the rare case of many rapid sends.
   */
  private startDrain(): void {
    this.stopDrain();
    this.drainTimer = setInterval(() => this.flushSendBuffer(), 5);
  }

  /** Stop the drain timer. */
  private stopDrain(): void {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  // ── heartbeat ───────────────────────────────────────────────────────────

  /**
   * Start the heartbeat mechanism on a WebSocket.
   *
   * Node.js (`ws` library): sends Ping frames every `pingPeriod` ms, and
   * sets a pong deadline timer of `pongWait` ms that is reset on each Pong.
   * If the deadline fires, the WebSocket is closed (triggering transport drop).
   *
   * Browser: Ping/Pong is handled automatically by the browser engine.
   * There is no programmatic access to ping/pong frames, so heartbeat
   * monitoring is a no-op in browser environments.
   */
  private startHeartbeat(ws: WS): void {
    // Only meaningful when ws supports .on() and .ping() (Node.js ws lib).
    if (typeof ws.on !== "function" || typeof ws.ping !== "function") return;

    const { pingPeriod, pongWait } = this.opts.heartbeat;

    // Reset (or start) the pong deadline timer.
    const resetPongDeadline = () => {
      this.clearPongDeadline();
      this.pongDeadlineTimer = setTimeout(() => {
        // Server failed to respond — close WS to trigger transport drop.
        ws.close(1001, "pong timeout");
      }, pongWait);
    };

    // Listen for Pong frames to reset the deadline.
    ws.on("pong", () => {
      resetPongDeadline();
    });

    // Start the initial deadline.
    resetPongDeadline();

    // Periodically send Ping frames.
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WS_OPEN && typeof ws.ping === "function") {
        ws.ping();
      }
    }, pingPeriod);
  }

  /** Stop heartbeat timers (ping + pong deadline). */
  private stopHeartbeat(): void {
    this.clearPongDeadline();
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Clear the pong deadline timer only. */
  private clearPongDeadline(): void {
    if (this.pongDeadlineTimer !== null) {
      clearTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }

  /**
   * Flush all buffered frames to the WebSocket.
   *
   * Stops draining if the socket is not open (reconnect will restart it).
   */
  private flushSendBuffer(): void {
    if (this.ws.readyState !== WS_OPEN) return;
    while (this.sendBuffer.length > 0) {
      const data = this.sendBuffer.shift() as string;
      try {
        this.ws.send(data);
      } catch {
        // Write error — the onclose handler will fire and trigger teardown.
        return;
      }
    }
  }

  /**
   * Send data with a writeWait timeout.
   *
   * Used for control frames (close message). For buffered data frames the
   * drain timer handles sending, and the `ws` library buffers internally,
   * so writeWait on data frames is not enforced (matching the Node.js
   * `ws` library's non-blocking send semantics).
   */
  private sendWithTimeout(data: string, timeoutMs: number): void {
    if (this.ws.readyState !== WS_OPEN) return;
    const timer = setTimeout(() => {
      // Write timed out — close the socket to trigger teardown.
      try {
        this.ws.close(1001, "write timeout");
      } catch {
        // Already closed.
      }
    }, timeoutMs);
    try {
      this.ws.send(data);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Transition to CLOSED state. Releases all resources.
   *
   * @param err `null` for clean close, an Error for abnormal disconnect.
   */
  private shutdown(err: Error | null): void {
    if (this.closed) return;
    this.closed = true;

    // Cancel any pending reconnect backoff delay.
    this.abortController.abort();

    // Stop the drain timer and heartbeat.
    this.stopDrain();
    this.stopHeartbeat();

    // Flush remaining buffer (best-effort) before closing the socket.
    this.flushSendBuffer();

    // Close the WebSocket. Suppress errors (may already be closed).
    try {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close(1000, "");
    } catch {
      // Already closed — ignore.
    }

    // Fire onDisconnect exactly once.
    if (!this.disconnectFired) {
      this.disconnectFired = true;
      this.opts.onDisconnect(err);
    }

    // Resolve the done Promise.
    this.doneResolve();
  }
}
