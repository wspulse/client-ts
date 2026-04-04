import type { Clock } from "./clock.js";
import type { Frame } from "./frame.js";
import type { Transport } from "./transport.js";
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

// ── URL scheme normalization ─────────────────────────────────────────────────

/**
 * Convert `http://` and `https://` URLs to their WebSocket equivalents
 * (`ws://` and `wss://`). All other URLs pass through unchanged — the
 * underlying WebSocket implementation (`ws` on Node.js, native
 * `WebSocket` in browsers) already validates schemes at connection
 * time and surfaces catchable errors, so we avoid duplicating that.
 *
 * @internal Exported for unit testing only.
 */
export function normalizeScheme(url: string): string {
  const lower = url.slice(0, 8).toLowerCase();
  if (lower.startsWith("https://"))
    return "wss://" + url.slice("https://".length);
  if (lower.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url;
}

// ── WebSocket dialer ─────────────────────────────────────────────────────────

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
async function dialWebSocket(
  url: string,
  opts: ResolvedOptions,
): Promise<Transport> {
  // Prefer 'ws' library when available (Node.js) — it supports custom
  // headers and has consistent binary/text handling across Node versions.
  // Dynamic import works in both Node.js ESM and CJS; falls back to the
  // native browser WebSocket API when 'ws' is not installed.
  let wsImpl: { new (url: string, opts?: unknown): Transport } | null = null;
  try {
    const mod = await import("ws");
    wsImpl = (mod.default ?? mod) as {
      new (url: string, opts?: unknown): Transport;
    };
  } catch {
    // 'ws' not installed — will use globalThis.WebSocket below.
  }

  const hasHeaders = Object.keys(opts.dialHeaders).length > 0;
  const wsOpts: Record<string, unknown> = {};
  if (hasHeaders) wsOpts.headers = opts.dialHeaders;

  return new Promise<Transport>((resolve, reject) => {
    let ws: Transport;

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
      ws = new globalThis.WebSocket(url) as unknown as Transport;
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
 * If the initial handshake fails, the Promise rejects immediately — regardless
 * of `autoReconnect`. No callbacks fire and no Client is created.
 * `autoReconnect` only kicks in after a successful initial connection.
 *
 * @param url  WebSocket URL (e.g. `wss://host/ws`). Also accepts `http://`
 *              and `https://` URLs, which are auto-converted to `ws://` and
 *              `wss://` respectively.
 * @param opts Client options (callbacks, reconnect config, etc.)
 * @returns A {@link Client} in CONNECTED state.
 *
 * @throws Error if the initial connection attempt fails.
 */
export async function connect(
  url: string,
  opts?: ClientOptions,
): Promise<Client> {
  url = normalizeScheme(url);
  const resolved = resolveOptions(opts);
  const dial = resolved._dialer ?? dialWebSocket;
  const ws = await dial(url, resolved);
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
  private ws: Transport;

  /** Bounded send buffer (throws when full). */
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

  /** Whether the reconnect loop is active. Guards onTransportDrop(null) in shutdown. */
  private reconnecting = false;

  /** Pong deadline timer — fires when server stops responding. */
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ping interval timer — sends WebSocket Ping frames (Node.js only). */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Stored pong handler reference for cleanup (prevents listener leak on reconnect). */
  private pongHandler: (() => void) | null = null;

  /** WebSocket instance the pong handler is attached to (for removeListener). */
  private pongHandlerWs: Transport | null = null;

  /** Timer clock — replaced in tests for deterministic behaviour. @internal */
  private readonly clock: Clock;

  constructor(url: string, opts: ResolvedOptions, ws: Transport) {
    this.url = url;
    this.opts = opts;
    this.ws = ws;
    this.clock = opts._clock;
    this.abortController = new AbortController();

    let resolve!: () => void;
    this.done = new Promise<void>((r) => {
      resolve = r;
    });
    this.doneResolve = resolve;

    // For binary codecs in browsers, set binaryType so data arrives as
    // ArrayBuffer instead of Blob.
    if (opts.codec.binaryType === "binary") {
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    }

    this.attachListeners(ws);
    this.startHeartbeat(ws);
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
    if (this.sendBuffer.length >= this.opts.sendBufferSize) {
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
  private attachListeners(ws: Transport): void {
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
      } catch (err) {
        console.warn("wspulse/client: decode failed, frame dropped", err);
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
    // Set reconnecting before firing the callback so that a synchronous
    // close() call inside onTransportDrop sees the correct state.
    if (this.opts.autoReconnect) {
      this.reconnecting = true;
    }
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

      // Attempt to dial.
      let newWs: Transport;
      try {
        const dial = this.opts._dialer ?? dialWebSocket;
        newWs = await dial(this.url, this.opts);
      } catch {
        // Dial failed — increment attempt and retry.
        attempt++;
        continue;
      }

      // Check if close() was called during the dial.
      if (this.closed) {
        newWs.close();
        return;
      }

      // Swap connection and restart listeners + drain + heartbeat.
      this.ws = newWs;
      if (this.opts.codec.binaryType === "binary") {
        (newWs as unknown as { binaryType: string }).binaryType = "arraybuffer";
      }
      this.attachListeners(newWs);
      this.startDrain();
      this.startHeartbeat(newWs);

      // Fire onTransportRestore outside the dial try/catch so a throwing
      // callback does not get misinterpreted as a dial failure.
      this.reconnecting = false;
      try {
        this.opts.onTransportRestore();
      } catch (err) {
        console.warn("wspulse/client: onTransportRestore threw", err);
      }
      return; // Successfully reconnected.
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
      const timer = this.clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      const onAbort = () => {
        this.clock.clearTimeout(timer);
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
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = null;
      this.flushSendBuffer();
    }, 5);
  }

  /** Stop the drain timer. */
  private stopDrain(): void {
    if (this.drainTimer !== null) {
      this.clock.clearTimeout(this.drainTimer);
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
  private startHeartbeat(ws: Transport): void {
    // Only meaningful when ws supports .on() and .ping() (Node.js ws lib).
    if (typeof ws.on !== "function" || typeof ws.ping !== "function") return;

    const { pingPeriod, pongWait } = this.opts.heartbeat;

    // Reset (or start) the pong deadline timer.
    const resetPongDeadline = () => {
      this.clearPongDeadline();
      this.pongDeadlineTimer = this.clock.setTimeout(() => {
        // Server failed to respond — forcefully destroy the socket so the
        // close event fires immediately without waiting for a close handshake.
        if (typeof ws.terminate === "function") {
          ws.terminate();
        } else {
          ws.close(1001, "pong timeout");
        }
      }, pongWait);
    };

    // Listen for Pong frames to reset the deadline.
    // Store the handler so it can be removed in stopHeartbeat().
    this.pongHandler = () => {
      resetPongDeadline();
    };
    this.pongHandlerWs = ws;
    ws.on("pong", this.pongHandler);

    // Send an initial Ping immediately so the pong deadline starts from a real
    // ping, not from connection open. This prevents false timeouts when
    // pingPeriod > pongWait.
    if (ws.readyState === WS_OPEN && typeof ws.ping === "function") {
      ws.ping();
    }
    resetPongDeadline();

    // Periodically send Ping frames.
    this.pingTimer = this.clock.setInterval(() => {
      if (ws.readyState === WS_OPEN && typeof ws.ping === "function") {
        ws.ping();
      }
    }, pingPeriod);
  }

  /** Stop heartbeat timers (ping + pong deadline) and remove pong listener. */
  private stopHeartbeat(): void {
    this.clearPongDeadline();
    if (this.pingTimer !== null) {
      this.clock.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    // Remove pong listener from the previous WebSocket to prevent leaks.
    if (
      this.pongHandler !== null &&
      this.pongHandlerWs !== null &&
      typeof this.pongHandlerWs.removeListener === "function"
    ) {
      this.pongHandlerWs.removeListener("pong", this.pongHandler);
    }
    this.pongHandler = null;
    this.pongHandlerWs = null;
  }

  /** Clear the pong deadline timer only. */
  private clearPongDeadline(): void {
    if (this.pongDeadlineTimer !== null) {
      this.clock.clearTimeout(this.pongDeadlineTimer);
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
    if (this.ws.readyState !== WS_OPEN) return;
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
    const timer = this.clock.setTimeout(() => {
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
        this.clock.clearTimeout(timer);
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
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close(1000, "");
    } catch {
      // Already closed — ignore.
    }

    // On clean close while NOT reconnecting, fire onTransportDrop(null) before
    // onDisconnect. When reconnecting, handleTransportDrop already fired — skip.
    if (err === null && !this.reconnecting) {
      try {
        this.opts.onTransportDrop(null);
      } catch (cbErr) {
        console.warn("wspulse/client: onTransportDrop threw", cbErr);
      }
    }
    this.reconnecting = false;

    // Fire onDisconnect exactly once.
    if (!this.disconnectFired) {
      this.disconnectFired = true;
      try {
        this.opts.onDisconnect(err);
      } catch (cbErr) {
        console.warn("wspulse/client: onDisconnect threw", cbErr);
      }
    }

    // Resolve the done Promise.
    this.doneResolve();
  }
}
