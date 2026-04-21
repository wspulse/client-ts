import type { Clock } from "./clock.js";
import type { Frame } from "./frame.js";
import type { Transport } from "./transport.js";
import type { ClientOptions, ResolvedOptions } from "./options.js";
import { resolveOptions } from "./options.js";
import { RingBuffer } from "./ring-buffer.js";
import {
  ConnectionClosedError,
  RetriesExhaustedError,
  ConnectionLostError,
  SendBufferFullError,
  ServerClosedError,
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

/** RFC 6455 close status codes. */
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_GOING_AWAY = 1001;

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
  private readonly sendBuffer: RingBuffer<string | Uint8Array>;

  /** Whether the client is permanently closed. */
  private closed = false;

  /**
   * Set by the client immediately before any internal `ws.close(code, reason)`
   * call that is NOT a server close (e.g. write timeout, write error). The
   * subsequent `ws.onclose` reads this flag to decide whether to surface a
   * {@link ServerClosedError} — a self-initiated close must not be reported
   * as if the server sent the close frame.
   */
  private selfClosing = false;

  /** Fires exactly once when the client reaches CLOSED state. */
  private readonly doneResolve: () => void;

  /** Public done Promise — resolves on permanent disconnect. */
  readonly done: Promise<void>;

  /** Drain timer for flushing the send buffer. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether an async flush is in progress (prevents re-entry). */
  private draining = false;

  /** AbortController for cancelling the reconnect loop. */
  private abortController: AbortController;

  /** Whether onDisconnect has been called (exactly-once guard). */
  private disconnectFired = false;

  /** Whether a transport drop is being handled. Suppresses onTransportDrop(null) during shutdown. */
  private reconnecting = false;

  /** Timer clock — replaced in tests for deterministic behaviour. @internal */
  private readonly clock: Clock;

  constructor(url: string, opts: ResolvedOptions, ws: Transport) {
    this.url = url;
    this.opts = opts;
    this.ws = ws;
    this.clock = opts._clock;
    this.sendBuffer = new RingBuffer(opts.sendBufferSize);
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
    if (!this.sendBuffer.push(data)) {
      throw new SendBufferFullError();
    }
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

    ws.onclose = (ev) => {
      // Preserve the close frame code and reason so callers can distinguish
      // server-initiated closes from abrupt network drops.
      //
      // Code 1006 ("abnormal closure") is synthesised by the WebSocket spec
      // when no close frame was received — treat as an abrupt drop.
      //
      // When the client self-closed for an internal error (write timeout,
      // write error), the browser also fires onclose with that same code
      // and reason. selfClosing distinguishes these from real server-
      // initiated closes.
      let dropErr: Error | undefined;
      if (this.selfClosing) {
        // Reset immediately — reconnect will create a fresh socket.
        this.selfClosing = false;
        dropErr = undefined;
      } else if (ev.code === 1006) {
        dropErr = undefined;
      } else {
        dropErr = new ServerClosedError(ev.code, ev.reason);
      }
      this.handleTransportDrop(dropErr);
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
   *
   * @param cause  If the drop was triggered by a server close frame, pass
   *               the {@link ServerClosedError} so onTransportDrop sees
   *               the code and reason. Leave undefined for abrupt drops
   *               (default: a generic "transport closed unexpectedly" error).
   */
  private handleTransportDrop(cause?: Error): void {
    if (this.closed) return;

    this.stopDrain();
    const dropErr =
      cause ?? new Error("wspulse: transport closed unexpectedly");
    // Set reconnecting before firing the callback so that a synchronous
    // close() call inside onTransportDrop sees the correct state regardless
    // of whether auto-reconnect is enabled.
    this.reconnecting = true;
    try {
      this.opts.onTransportDrop(dropErr);
    } catch (cbErr) {
      console.warn("wspulse/client: onTransportDrop threw", cbErr);
    }

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

      // Swap connection and restart listeners + drain.
      this.ws = newWs;
      if (this.opts.codec.binaryType === "binary") {
        (newWs as unknown as { binaryType: string }).binaryType = "arraybuffer";
      }
      this.attachListeners(newWs);
      this.startDrain();

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
    if (this.draining || this.drainTimer !== null) return;
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = null;
      void this.flushSendBuffer();
    }, 5);
  }

  /**
   * Stop any scheduled drain timer.
   *
   * Does not reset `draining` — an async flush may be in progress and
   * its `finally` block is responsible for clearing the flag.
   */
  private stopDrain(): void {
    if (this.drainTimer !== null) {
      this.clock.clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /**
   * Flush all buffered frames to the WebSocket serially with per-write
   * timeout. On Node.js each frame is sent via `sendOneFrame` so a
   * stalled socket is detected within `writeWait`. In browsers `send()`
   * is fire-and-forget (no completion callback) so no deadline applies.
   *
   * Stops draining if the socket is not open (reconnect will restart it).
   */
  private async flushSendBuffer(): Promise<void> {
    if (this.ws.readyState !== WS_OPEN) return;
    this.draining = true;
    try {
      while (this.sendBuffer.length > 0 && !this.closed) {
        if (this.ws.readyState !== WS_OPEN) return;
        const encoded = this.sendBuffer.peek();
        // Defensive: T is NonNullable, so this path is unreachable under
        // correct usage. Shift and skip rather than break to avoid leaving
        // a stale entry that would re-trigger drain indefinitely.
        if (encoded === undefined) {
          this.sendBuffer.shift();
          continue;
        }
        const ok = await this.sendOneFrame(encoded);
        if (!ok) return; // timeout or error — socket is closing
        this.sendBuffer.shift();
      }
    } finally {
      this.draining = false;
      // If new frames arrived during the flush, schedule another drain.
      if (this.sendBuffer.length > 0 && !this.closed) {
        this.startDrain();
      }
    }
  }

  /**
   * Send a single frame with write-deadline enforcement.
   *
   * On Node.js (`ws` library): uses the callback form of `send()` and
   * races it against a `writeWait` timeout. On timeout the socket is
   * closed, which triggers `handleTransportDrop`.
   *
   * In browsers: `send()` is fire-and-forget; returns `true` immediately.
   *
   * @returns `true` if the write completed, `false` if it timed out or errored.
   */
  private sendOneFrame(data: string | Uint8Array): Promise<boolean> {
    if (this.ws.readyState !== WS_OPEN) return Promise.resolve(false);
    const ws = this.ws;

    // Browsers: no write-completion event — send is best-effort.
    if (typeof ws.on !== "function") {
      try {
        ws.send(data);
      } catch {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    }

    // Node.js ws: race callback vs writeWait timeout.
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this.selfClosing = true;
          ws.close(WS_CLOSE_GOING_AWAY, "write timeout");
        } catch {
          // Already closed.
        }
        resolve(false);
      }, this.opts.writeWait);
      try {
        (
          ws.send as (d: string | Uint8Array, cb: (err?: Error) => void) => void
        )(data, (err) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(timer);
          if (err) {
            try {
              this.selfClosing = true;
              ws.close(WS_CLOSE_GOING_AWAY, "write error");
            } catch {
              // Already closed.
            }
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } catch {
        // ws.send() threw synchronously (e.g. socket state changed between
        // readyState check and send call). Close the socket so onclose fires
        // and triggers the transport drop / reconnect path.
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        try {
          this.selfClosing = true;
          ws.close(WS_CLOSE_GOING_AWAY, "write error");
        } catch {
          // Already closed.
        }
        resolve(false);
      }
    });
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

    // Stop the drain timer.
    this.stopDrain();

    // Discard unsent frames — close() does not drain the send buffer.
    this.sendBuffer.clear();

    // Close the WebSocket. Suppress errors (may already be closed).
    try {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close(WS_CLOSE_NORMAL, "");
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
