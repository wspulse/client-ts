import type { Frame } from "./frame.js";
import type { ClientOptions, ResolvedOptions } from "./options.js";
import { resolveOptions } from "./options.js";
import {
  ConnectionClosedError,
  RetriesExhaustedError,
  ConnectionLostError,
  SendBufferFullError,
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
   * Non-blocking.
   *
   * @throws {@link ConnectionClosedError} if the client is in CLOSED state.
   * @throws {@link SendBufferFullError} if the internal send buffer is full.
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
  send(data: string | ArrayBuffer | Uint8Array | Blob): void;
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
 *
 * Uses dynamic `import("ws")` so the function works in both Node.js ESM and
 * CJS environments without relying on `require`, which is unavailable in ESM.
 */
async function dialWebSocket(url: string, opts: ResolvedOptions): Promise<WS> {
  // Prefer 'ws' library when available (Node.js) — it supports custom
  // headers and has consistent binary/text handling across Node versions.
  // Dynamic import works in both Node.js ESM and CJS; falls back to the
  // native browser WebSocket API when 'ws' is not installed.
  let wsImpl: { new (url: string, opts?: unknown): WS } | null = null;
  try {
    const mod = await import("ws");
    wsImpl = (mod.default ?? mod) as { new (url: string, opts?: unknown): WS };
  } catch {
    // 'ws' not installed — will use globalThis.WebSocket below.
  }

  const hasHeaders = Object.keys(opts.dialHeaders).length > 0;
  const wsOpts: Record<string, unknown> = {};
  if (hasHeaders) wsOpts.headers = opts.dialHeaders;

  return new Promise<WS>((resolve, reject) => {
    let ws: WS;

    if (wsImpl !== null) {
      ws = new wsImpl(url, Object.keys(wsOpts).length > 0 ? wsOpts : undefined);
    } else {
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
    // Capture the actual Error from Node.js ws 'error' event before onerror
    // fires; avoids "[object Event]" in the reject message.
    let lastError: Error | null = null;
    if (typeof ws.on === "function") {
      ws.on("error", (err: unknown) => {
        if (err instanceof Error) lastError = err;
      });
    }
    ws.onerror = (ev) => {
      ws.onopen = null;
      ws.onerror = null;
      const msg =
        lastError?.message ??
        (ev as { message?: string }).message ??
        "connection failed";
      reject(new Error(`wspulse: dial failed: ${msg}`));
    };
  });
}

// ── Client implementation ─────────────────────────────────────────────────────

/**
 * Connect to a wspulse WebSocket server.
 *
 * The returned Promise resolves once the initial WebSocket handshake completes.
 * If `autoReconnect` is configured and the initial handshake fails, the Promise
 * still resolves with a client in RECONNECTING state — the client will retry
 * using the configured backoff, and `onDisconnect` fires only when all retries
 * are exhausted. Without `autoReconnect`, a failed initial handshake rejects
 * the Promise immediately.
 *
 * @param url  WebSocket URL (e.g. `wss://host/ws`)
 * @param opts Client options (callbacks, reconnect config, etc.)
 * @returns A {@link Client} in CONNECTED or RECONNECTING state.
 *
 * @throws Error if the initial connection attempt fails and `autoReconnect` is
 *         not configured.
 */
export async function connect(
  url: string,
  opts?: ClientOptions,
): Promise<Client> {
  const resolved = resolveOptions(opts);
  if (!resolved.autoReconnect) {
    // No reconnect configured: fail fast on initial dial failure.
    const ws = await dialWebSocket(url, resolved);
    return new WspulseClient(url, resolved, ws);
  }
  try {
    const ws = await dialWebSocket(url, resolved);
    return new WspulseClient(url, resolved, ws);
  } catch (err) {
    // Initial dial failed — surface the root cause via onTransportDrop so
    // callers can log/observe it, then enter RECONNECTING state.
    const cause = err instanceof Error ? err : new Error(String(err));
    resolved.onTransportDrop(cause);
    return new WspulseClient(url, resolved, null);
  }
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
  private ws: WS | null;

  /** Bounded send buffer with head-drop on overflow. */
  private readonly sendBuffer: (string | Uint8Array)[] = [];

  /** Whether the client is permanently closed. */
  private closed = false;

  /** Fires exactly once when the client reaches CLOSED state. */
  private readonly doneResolve: () => void;

  /** Public done Promise — resolves on permanent disconnect. */
  readonly done: Promise<void>;

  /** Drain timer for flushing the send buffer. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  /** AbortController for cancelling the reconnect loop. */
  private abortController: AbortController;

  /** Whether onDisconnect has been called (exactly-once guard). */
  private disconnectFired = false;

  /** Pong deadline timer — fires when server stops responding. */
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ping interval timer — sends WebSocket Ping frames (Node.js only). */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string, opts: ResolvedOptions, ws: WS | null) {
    this.url = url;
    this.opts = opts;
    this.ws = ws;
    this.abortController = new AbortController();

    let resolve!: () => void;
    this.done = new Promise<void>((r) => {
      resolve = r;
    });
    this.doneResolve = resolve;

    // For binary codecs in browsers, set binaryType so data arrives as
    // ArrayBuffer instead of Blob.
    if (opts.codec.binaryType === "binary" && ws !== null) {
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    }

    if (ws !== null) {
      this.attachListeners(ws);
      this.startHeartbeat(ws);
    } else {
      // Initial dial failed with autoReconnect configured — start retry loop.
      void this.reconnectLoop();
    }
  }

  /**
   * Enqueue a Frame for delivery.
   *
   * @throws {@link ConnectionClosedError} if the client is in CLOSED state.
   * @throws {@link SendBufferFullError} if the internal send buffer is full.
   */
  send(frame: Frame): void {
    if (this.closed) {
      throw new ConnectionClosedError();
    }
    const data = this.opts.codec.encode(frame);
    if (this.sendBuffer.length >= SEND_BUFFER_SIZE) {
      throw new SendBufferFullError();
    }
    this.sendBuffer.push(data);
    this.startDrain();
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

      // Normalize ev.data into `string | Uint8Array` for the Codec and
      // measure the raw byte length for maxMessageSize enforcement.
      const data = ev.data;
      let normalized: string | Uint8Array;
      let byteLength: number;

      if (typeof data === "string") {
        normalized = data;
        byteLength =
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(data, "utf8")
            : new TextEncoder().encode(data).byteLength;
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
        const buf = data as Buffer;
        byteLength = buf.byteLength;
        normalized = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } else if (data instanceof ArrayBuffer) {
        byteLength = data.byteLength;
        normalized = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        byteLength = data.byteLength;
        normalized = new Uint8Array(
          data.buffer as ArrayBuffer,
          data.byteOffset,
          data.byteLength,
        );
      } else {
        // Unsupported payload type (e.g. Blob when binaryType was not set
        // to "arraybuffer"). Close with 1003 "unsupported data".
        ws.onclose = null;
        ws.close(1003, "unsupported payload type");
        this.handleTransportDrop();
        return;
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
        const frame = this.opts.codec.decode(normalized);
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
    // autoReconnect is guaranteed non-null here — called only when
    // this.opts.autoReconnect is truthy (from handleTransportDrop or constructor).
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
        if (this.opts.codec.binaryType === "binary") {
          (newWs as unknown as { binaryType: string }).binaryType =
            "arraybuffer";
        }
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
   * Start the drain timer that flushes the send buffer after a short delay.
   *
   * Uses a one-shot timer so idle clients do not incur continuous wakeups.
   * Called from send() and after a successful reconnect.
   */
  private startDrain(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.flushSendBuffer();
    }, 5);
  }

  /** Stop the drain timer. */
  private stopDrain(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
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

    // Send an initial Ping immediately so the pong deadline starts from a real
    // ping, not from connection open. This prevents false timeouts when
    // pingPeriod > pongWait.
    if (ws.readyState === WS_OPEN && typeof ws.ping === "function") {
      ws.ping();
    }
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
    if (this.ws === null || this.ws.readyState !== WS_OPEN) return;
    // splice(0) grabs all frames in O(n) — avoids O(n²) from repeated shift().
    const frames = this.sendBuffer.splice(0);
    for (const encoded of frames) {
      try {
        this.ws.send(encoded);
      } catch {
        // Write error — the onclose handler will fire and trigger teardown.
        return;
      }
    }
  }

  /**
   * Send data with a write-deadline timeout.
   *
   * Used to flush buffered frames during shutdown. If a blocked socket
   * does not complete the send within `writeWait` ms, the timer fires
   * and closes the socket with code 1001 "write timeout".
   *
   * In Node.js (ws library) the callback form `send(data, cb)` fires after
   * the data is handed off to the kernel, so the deadline is cleared only
   * on true write completion. In browsers `send()` has no completion callback
   * and the call is best-effort with no enforced deadline.
   *
   * Regular data frames are sent via the one-shot drain timer in `send()`;
   * `writeWait` guards only this shutdown-flush path.
   */
  private sendWithTimeout(data: string | Uint8Array, timeoutMs: number): void {
    if (this.ws === null || this.ws.readyState !== WS_OPEN) return;
    const ws = this.ws;

    // Browsers do not surface write-completion events — send is best-effort.
    if (typeof ws.on !== "function") {
      ws.send(data);
      return;
    }

    // Node.js ws: use the callback form so the deadline clears only after the
    // data has been handed off to the kernel. If the timer fires first the
    // socket is closed, which will abort any in-progress send.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close(1001, "write timeout");
      } catch {
        // Already closed.
      }
    }, timeoutMs);
    (ws.send as (d: string | Uint8Array, cb: (err?: Error) => void) => void)(
      data,
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try {
            ws.close(1001, "write error");
          } catch {
            // Already closed.
          }
        }
      },
    );
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

    // Flush remaining buffer with write deadline before closing.
    while (this.sendBuffer.length > 0) {
      this.sendWithTimeout(
        this.sendBuffer.shift() as string | Uint8Array,
        this.opts.writeWait,
      );
    }

    // Close the WebSocket. Suppress errors (may already be closed).
    try {
      if (this.ws !== null) {
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close(1000, "");
      }
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
