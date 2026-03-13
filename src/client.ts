import type { Frame } from "./frame.js";
import type { ClientOptions } from "./options.js";

/**
 * Public interface for the wspulse WebSocket client.
 */
export interface Client {
  /** Enqueue a Frame for delivery. Throws ConnectionClosedError if closed. */
  send(frame: Frame): void;

  /** Permanently terminate the connection and stop any reconnect loop. Idempotent. */
  close(): void;

  /** Resolves when the client permanently disconnects. */
  readonly done: Promise<void>;
}

/**
 * Connect to a wspulse WebSocket server.
 *
 * @param url  WebSocket URL (e.g. `wss://host/ws`)
 * @param opts Client options (callbacks, reconnect config, etc.)
 * @returns A connected Client
 *
 * @throws Error if the initial connection fails and autoReconnect is disabled.
 */
export async function connect(
  _url: string,
  _opts?: ClientOptions,
): Promise<Client> {
  // TODO: implement in P2
  throw new Error("wspulse: connect() not yet implemented");
}
