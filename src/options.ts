import type { Frame } from "./frame.js";

/**
 * Configuration for exponential backoff reconnection.
 *
 * When provided to {@link ClientOptions.autoReconnect}, the client will
 * automatically attempt to re-establish the WebSocket connection on
 * transport drops, using exponential backoff with equal jitter.
 */
export interface AutoReconnectOptions {
  /** Max retry attempts. 0 or negative = unlimited. */
  maxRetries: number;
  /** Base delay in milliseconds. */
  baseDelay: number;
  /** Maximum delay in milliseconds. */
  maxDelay: number;
}

/**
 * Client-side heartbeat timing expectations.
 *
 * These values configure the client's expectation of server-side Ping timing.
 * The wspulse server sends WebSocket Ping frames every `pingPeriod` and
 * expects a Pong within `pongWait`. Standard WebSocket libraries respond
 * to Pong automatically.
 */
export interface HeartbeatOptions {
  /** Expected server ping period in milliseconds. */
  pingPeriod: number;
  /** Max wait for pong before considering connection dead, in milliseconds. */
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

  /** Enable exponential backoff reconnection. Disabled by default. */
  autoReconnect?: AutoReconnectOptions;
  /** Heartbeat timing expectations. Defaults to 20 s ping / 60 s pong. */
  heartbeat?: HeartbeatOptions;
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

/** @internal Default max inbound message: 1 MiB. */
const DEFAULT_MAX_MESSAGE_SIZE = 1 << 20;

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
  autoReconnect: AutoReconnectOptions | undefined;
  heartbeat: HeartbeatOptions;
  maxMessageSize: number;
  dialHeaders: Record<string, string>;
}

/** @internal Shared no-op callback for all unset option callbacks. */
const noop = () => {};

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
  return {
    onMessage: opts?.onMessage ?? noop,
    onDisconnect: opts?.onDisconnect ?? noop,
    onReconnect: opts?.onReconnect ?? noop,
    onTransportDrop: opts?.onTransportDrop ?? noop,
    autoReconnect: opts?.autoReconnect,
    heartbeat: opts?.heartbeat ?? DEFAULT_HEARTBEAT,
    maxMessageSize: opts?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
    dialHeaders: opts?.dialHeaders ?? {},
  };
}
