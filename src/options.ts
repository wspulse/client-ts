import type { Frame } from "./frame.js";

export interface AutoReconnectOptions {
  /** Max retry attempts. 0 or negative = unlimited. */
  maxRetries: number;
  /** Base delay in milliseconds. */
  baseDelay: number;
  /** Maximum delay in milliseconds. */
  maxDelay: number;
}

export interface HeartbeatOptions {
  /** Expected server ping period in milliseconds. */
  pingPeriod: number;
  /** Max wait for pong before considering connection dead, in milliseconds. */
  pongWait: number;
}

export interface ClientOptions {
  onMessage?: (frame: Frame) => void;
  onDisconnect?: (err: Error | null) => void;
  onReconnect?: (attempt: number) => void;
  onTransportDrop?: (err: Error) => void;
  autoReconnect?: AutoReconnectOptions;
  heartbeat?: HeartbeatOptions;
  /** Write deadline in milliseconds. */
  writeWait?: number;
  /** Max inbound message size in bytes. */
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

const DEFAULT_HEARTBEAT: HeartbeatOptions = {
  pingPeriod: 20_000,
  pongWait: 60_000,
};

const DEFAULT_WRITE_WAIT = 10_000;
const DEFAULT_MAX_MESSAGE_SIZE = 1 << 20; // 1 MiB

export interface ResolvedOptions {
  onMessage: (frame: Frame) => void;
  onDisconnect: (err: Error | null) => void;
  onReconnect: (attempt: number) => void;
  onTransportDrop: (err: Error) => void;
  autoReconnect: AutoReconnectOptions | undefined;
  heartbeat: HeartbeatOptions;
  writeWait: number;
  maxMessageSize: number;
  dialHeaders: Record<string, string>;
}

const noop = () => {};

export function resolveOptions(opts?: ClientOptions): ResolvedOptions {
  return {
    onMessage: opts?.onMessage ?? noop,
    onDisconnect: opts?.onDisconnect ?? noop,
    onReconnect: opts?.onReconnect ?? noop,
    onTransportDrop: opts?.onTransportDrop ?? noop,
    autoReconnect: opts?.autoReconnect,
    heartbeat: opts?.heartbeat ?? DEFAULT_HEARTBEAT,
    writeWait: opts?.writeWait ?? DEFAULT_WRITE_WAIT,
    maxMessageSize: opts?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
    dialHeaders: opts?.dialHeaders ?? {},
  };
}
