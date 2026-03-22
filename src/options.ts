import type { Frame } from "./frame.js";
import type { Codec } from "./codec.js";
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
 * Client-side heartbeat configuration.
 *
 * The client sends WebSocket Ping frames every `pingPeriod` ms.
 * If no Pong is received within `pongWait` ms, the connection is considered
 * dead and the transport is closed.
 *
 * Note: browser environments have no programmatic Ping/Pong API — heartbeat
 * monitoring is a no-op there; the browser engine handles keepalive internally.
 */
export interface HeartbeatOptions {
  /** Interval between client-sent Ping frames, in milliseconds. */
  pingPeriod: number;
  /** Pong deadline in milliseconds; connection closes if no Pong is received. */
  pongWait: number;
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
   * Called at the start of each reconnect attempt (before the dial).
   * @param attempt 0-based attempt number (first retry = 0).
   */
  onReconnect?: (attempt: number) => void;

  /**
   * Called each time the underlying WebSocket connection drops unexpectedly,
   * before any reconnect attempt. Does not fire when `close()` is called.
   */
  onTransportDrop?: (err: Error) => void;

  /**
   * Wire-format codec for encoding/decoding {@link Frame}s.
   *
   * Defaults to {@link JSONCodec} (JSON text frames). Provide a custom
   * implementation (e.g. Protocol Buffers) to use binary frames.
   */
  codec?: Codec;
  /** Enable exponential backoff reconnection. Disabled by default. */
  autoReconnect?: AutoReconnectOptions;
  /** Heartbeat timing expectations. Defaults to 20 s ping / 60 s pong. */
  heartbeat?: HeartbeatOptions;
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
}

/** @internal Default heartbeat timing: 20 s ping, 60 s pong. */
const DEFAULT_HEARTBEAT: HeartbeatOptions = {
  pingPeriod: 20_000,
  pongWait: 60_000,
};

/** @internal Default write deadline: 10 seconds. */
const DEFAULT_WRITE_WAIT = 10_000;

/** @internal Default max inbound message: 1 MiB. */
const DEFAULT_MAX_MESSAGE_SIZE = 1 << 20;

/** @internal Upper bound constants for config validation. */
const MAX_PING_PERIOD = 60_000;
const MAX_PONG_WAIT = 120_000;
const MAX_WRITE_WAIT = 30_000;
const MAX_MSG_SIZE_BYTES = 64 << 20;
const MAX_BASE_DELAY = 60_000;
const MAX_MAX_DELAY = 300_000;
const MAX_MAX_RETRIES = 32;

/**
 * Internal fully-resolved options with all defaults applied.
 *
 * Produced by {@link resolveOptions}. Every field is guaranteed non-undefined.
 * Callbacks are no-ops when the caller did not provide them.
 */
export interface ResolvedOptions {
  onMessage: (frame: Frame) => void;
  onDisconnect: (err: Error | null) => void;
  onReconnect: (attempt: number) => void;
  onTransportDrop: (err: Error) => void;
  codec: Codec;
  autoReconnect: AutoReconnectOptions | undefined;
  heartbeat: HeartbeatOptions;
  writeWait: number;
  maxMessageSize: number;
  dialHeaders: Record<string, string>;
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
    if (opts.maxMessageSize < 0) {
      throw new Error("wspulse: maxMessageSize must be non-negative");
    }
    if (opts.maxMessageSize > MAX_MSG_SIZE_BYTES) {
      throw new Error("wspulse: maxMessageSize exceeds maximum (64 MiB)");
    }
  }

  if (opts.writeWait !== undefined) {
    if (opts.writeWait <= 0) {
      throw new Error("wspulse: writeWait must be positive");
    }
    if (opts.writeWait > MAX_WRITE_WAIT) {
      throw new Error("wspulse: writeWait exceeds maximum (30s)");
    }
  }

  if (opts.heartbeat !== undefined) {
    const hb = opts.heartbeat;
    if (hb.pingPeriod <= 0) {
      throw new Error("wspulse: heartbeat.pingPeriod must be positive");
    }
    if (hb.pingPeriod > MAX_PING_PERIOD) {
      throw new Error("wspulse: heartbeat.pingPeriod exceeds maximum (1m)");
    }
    if (hb.pongWait <= 0) {
      throw new Error("wspulse: heartbeat.pongWait must be positive");
    }
    if (hb.pongWait > MAX_PONG_WAIT) {
      throw new Error("wspulse: heartbeat.pongWait exceeds maximum (2m)");
    }
    if (hb.pingPeriod >= hb.pongWait) {
      throw new Error(
        "wspulse: heartbeat.pingPeriod must be strictly less than heartbeat.pongWait",
      );
    }
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
      throw new Error("wspulse: autoReconnect.maxDelay must be >= autoReconnect.baseDelay");
    }
    if (rc.maxDelay > MAX_MAX_DELAY) {
      throw new Error("wspulse: autoReconnect.maxDelay exceeds maximum (5m)");
    }
    if (rc.maxRetries > 0 && rc.maxRetries > MAX_MAX_RETRIES) {
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
    onReconnect: opts?.onReconnect ?? noop,
    onTransportDrop: opts?.onTransportDrop ?? noop,
    codec: opts?.codec ?? JSONCodec,
    autoReconnect: opts?.autoReconnect,
    heartbeat: opts?.heartbeat ?? { ...DEFAULT_HEARTBEAT },
    writeWait: opts?.writeWait ?? DEFAULT_WRITE_WAIT,
    maxMessageSize: opts?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
    dialHeaders: opts?.dialHeaders ?? {},
  };
}
