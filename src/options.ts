import type { Clock } from "./clock.js";
import type { Frame } from "./frame.js";
import type { Codec } from "./codec.js";
import type { Transport } from "./transport.js";
import { defaultClock } from "./clock.js";
import { JSONCodec } from "./codec.js";

/**
 * Configuration for exponential backoff reconnection.
 *
 * When provided to {@link ClientOptions.autoReconnect}, the client will
 * automatically attempt to re-establish the WebSocket connection on
 * transport drops, using exponential backoff with equal jitter.
 */
export interface AutoReconnectOptions {
  /** Max retry attempts. 0 = unlimited. Must be non-negative. */
  maxRetries: number;
  /** Base delay in milliseconds. */
  baseDelay: number;
  /** Maximum delay in milliseconds. */
  maxDelay: number;
}

/**
 * Options accepted by {@link connect}.
 *
 * All callbacks default to no-ops. Callbacks are invoked synchronously in
 * the read/reconnect task — do not block inside them.
 */
export interface ClientOptions {
  /**
   * Called for every inbound frame decoded by the codec.
   * Must not fire after `onDisconnect` has been called.
   */
  onMessage?: (frame: Frame) => void;

  /**
   * Called exactly once when the client reaches CLOSED state.
   *
   * - `null` for a clean close (user called `close()`).
   * - {@link RetriesExhaustedError} when max retries are exhausted.
   * - {@link ConnectionLostError} when server drops and auto-reconnect is off.
   *
   * This is always the last callback to fire.
   */
  onDisconnect?: (err: Error | null) => void;

  /**
   * Called after a successful reconnect when the new transport is ready
   * and pumps are running. Does not fire on the initial connection.
   */
  onTransportRestore?: () => void;

  /**
   * Called each time the underlying WebSocket connection closes, before any
   * reconnect attempt. Fires with `null` on a clean `close()` call, or with
   * the transport error on unexpected drops. When `close()` is called while
   * reconnecting, this callback does not fire again.
   */
  onTransportDrop?: (err: Error | null) => void;

  /**
   * Wire-format codec for encoding/decoding {@link Frame}s.
   *
   * Defaults to {@link JSONCodec} (JSON text frames). Provide a custom
   * implementation (e.g. Protocol Buffers) to use binary frames.
   */
  codec?: Codec;
  /** Enable exponential backoff reconnection. Disabled by default. */
  autoReconnect?: AutoReconnectOptions;
  /** Write deadline in milliseconds. Default: 10 000 (10 s). */
  writeWait?: number;
  /** Max inbound message size in bytes. Default: 1 MiB (1 048 576). */
  maxMessageSize?: number;
  /**
   * Extra HTTP headers for the WebSocket upgrade.
   *
   * **Node.js only.** Browsers prohibit custom headers on WebSocket handshake
   * requests (the `Upgrade` request is issued by the browser itself and the
   * `WebSocket` API provides no mechanism to attach arbitrary headers).
   * This option is silently ignored in browser environments.
   */
  dialHeaders?: Record<string, string>;

  /**
   * Maximum number of outbound frames that can be buffered before
   * {@link Client.send} throws {@link SendBufferFullError}.
   *
   * Must be between 1 and 4096 inclusive. Default: 256.
   */
  sendBufferSize?: number;

  /**
   * Custom dialer function for testing.
   *
   * @internal Test-only. When provided, `connect()` and the reconnect loop
   * use this function instead of opening a real WebSocket connection.
   * The default (`undefined`) falls back to the built-in `dialWebSocket`.
   */
  _dialer?: (url: string, opts: ResolvedOptions) => Promise<Transport>;

  /**
   * Custom timer clock for testing.
   *
   * @internal Test-only. When provided, all `setTimeout` calls in the client
   * are routed through this clock instead of the global timer functions.
   * The default (`undefined`) falls back to {@link defaultClock}.
   */
  _clock?: Clock;
}

/** @internal Default write deadline: 10 seconds. */
const DEFAULT_WRITE_WAIT = 10_000;

/** @internal Default max inbound message: 1 MiB. */
const DEFAULT_MAX_MESSAGE_SIZE = 1 << 20;

/** @internal Default send buffer capacity: 256 frames. */
const DEFAULT_SEND_BUFFER_SIZE = 256;

/** @internal Upper bound for send buffer size. */
const MAX_SEND_BUFFER_SIZE = 4096;

/** @internal Upper bound constants for config validation. */
const MAX_WRITE_WAIT = 30_000;
const MAX_MSG_SIZE_BYTES = 64 << 20;
const MAX_BASE_DELAY = 60_000;
const MAX_DELAY_LIMIT = 300_000;
const MAX_RETRIES_LIMIT = 32;

/**
 * Internal fully-resolved options with all defaults applied.
 *
 * Produced by {@link resolveOptions}. Every field is guaranteed non-undefined.
 * Callbacks are no-ops when the caller did not provide them.
 */
export interface ResolvedOptions {
  onMessage: (frame: Frame) => void;
  onDisconnect: (err: Error | null) => void;
  onTransportRestore: () => void;
  onTransportDrop: (err: Error | null) => void;
  codec: Codec;
  autoReconnect: AutoReconnectOptions | undefined;
  writeWait: number;
  maxMessageSize: number;
  dialHeaders: Record<string, string>;
  sendBufferSize: number;
  _dialer?: (url: string, opts: ResolvedOptions) => Promise<Transport>;
  /** @internal */
  _clock: Clock;
}

/** @internal Shared no-op callback for all unset option callbacks. */
const noop = () => {};

/**
 * Validate caller-provided options. Throws on invalid config.
 *
 * @internal
 */
function validateOptions(opts: ClientOptions): void {
  if (opts.maxMessageSize !== undefined) {
    if (!Number.isFinite(opts.maxMessageSize)) {
      throw new Error("wspulse: maxMessageSize must be a finite number");
    }
    if (opts.maxMessageSize < 0) {
      throw new Error("wspulse: maxMessageSize must be non-negative");
    }
    if (opts.maxMessageSize > MAX_MSG_SIZE_BYTES) {
      throw new Error("wspulse: maxMessageSize exceeds maximum (64 MiB)");
    }
  }

  if (opts.writeWait !== undefined) {
    if (!Number.isFinite(opts.writeWait)) {
      throw new Error("wspulse: writeWait must be a finite number");
    }
    if (opts.writeWait <= 0) {
      throw new Error("wspulse: writeWait must be positive");
    }
    if (opts.writeWait > MAX_WRITE_WAIT) {
      throw new Error("wspulse: writeWait exceeds maximum (30s)");
    }
  }

  if (opts.sendBufferSize !== undefined) {
    if (
      !Number.isFinite(opts.sendBufferSize) ||
      !Number.isInteger(opts.sendBufferSize)
    ) {
      throw new Error("wspulse: sendBufferSize must be a finite integer");
    }
    if (opts.sendBufferSize < 1) {
      throw new Error("wspulse: sendBufferSize must be at least 1");
    }
    if (opts.sendBufferSize > MAX_SEND_BUFFER_SIZE) {
      throw new Error(
        `wspulse: sendBufferSize exceeds maximum (${MAX_SEND_BUFFER_SIZE})`,
      );
    }
  }

  if (opts._dialer !== undefined && typeof opts._dialer !== "function") {
    throw new Error("wspulse: _dialer must be a function");
  }

  if (opts._clock !== undefined && typeof opts._clock !== "object") {
    throw new Error("wspulse: _clock must be an object");
  }

  if (opts.autoReconnect !== undefined) {
    const rc = opts.autoReconnect;
    if (rc.maxRetries < 0) {
      throw new Error("wspulse: autoReconnect.maxRetries must be non-negative");
    }
    if (rc.baseDelay <= 0) {
      throw new Error("wspulse: autoReconnect.baseDelay must be positive");
    }
    if (rc.baseDelay > MAX_BASE_DELAY) {
      throw new Error("wspulse: autoReconnect.baseDelay exceeds maximum (1m)");
    }
    if (rc.maxDelay < rc.baseDelay) {
      throw new Error(
        "wspulse: autoReconnect.maxDelay must be >= autoReconnect.baseDelay",
      );
    }
    if (rc.maxDelay > MAX_DELAY_LIMIT) {
      throw new Error("wspulse: autoReconnect.maxDelay exceeds maximum (5m)");
    }
    if (rc.maxRetries > 0 && rc.maxRetries > MAX_RETRIES_LIMIT) {
      throw new Error("wspulse: autoReconnect.maxRetries exceeds maximum (32)");
    }
  }
}

/**
 * Merge caller-provided options with defaults.
 *
 * Missing callbacks are replaced with no-ops. Missing scalar values
 * receive the documented defaults.
 *
 * @param opts Optional caller options.
 * @returns Fully resolved options, safe to use without null checks.
 */
export function resolveOptions(opts?: ClientOptions): ResolvedOptions {
  if (opts) {
    validateOptions(opts);
  }
  return {
    onMessage: opts?.onMessage ?? noop,
    onDisconnect: opts?.onDisconnect ?? noop,
    onTransportRestore: opts?.onTransportRestore ?? noop,
    onTransportDrop: opts?.onTransportDrop ?? noop,
    codec: opts?.codec ?? JSONCodec,
    autoReconnect: opts?.autoReconnect,
    writeWait: opts?.writeWait ?? DEFAULT_WRITE_WAIT,
    maxMessageSize: opts?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
    dialHeaders: opts?.dialHeaders ?? {},
    sendBufferSize: opts?.sendBufferSize ?? DEFAULT_SEND_BUFFER_SIZE,
    _dialer: opts?._dialer,
    _clock: opts?._clock ?? defaultClock,
  };
}
