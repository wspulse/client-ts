/**
 * Thrown by {@link Client.send} when the client is in CLOSED state.
 *
 * This error is always synchronous — it indicates a programmer mistake
 * (calling send after close), not a transient network issue.
 */
export class ConnectionClosedError extends Error {
  constructor() {
    super("wspulse: connection is closed");
    this.name = "ConnectionClosedError";
  }
}

/**
 * Passed to {@link ClientOptions.onDisconnect} when all reconnect attempts
 * have been exhausted without re-establishing a connection.
 *
 * Only occurs when {@link AutoReconnectOptions} is enabled and `maxRetries > 0`.
 */
export class RetriesExhaustedError extends Error {
  constructor() {
    super("wspulse: max reconnect retries exhausted");
    this.name = "RetriesExhaustedError";
  }
}

/**
 * Passed to {@link ClientOptions.onDisconnect} when the server drops the
 * connection and auto-reconnect is disabled.
 */
export class ConnectionLostError extends Error {
  constructor() {
    super("wspulse: connection lost");
    this.name = "ConnectionLostError";
  }
}

/**
 * Thrown by {@link Client.send} when the internal send buffer is full.
 *
 * The caller should handle this error explicitly — for example by retrying,
 * discarding the frame, or closing the connection.
 */
export class SendBufferFullError extends Error {
  constructor() {
    super("wspulse: send buffer full");
    this.name = "SendBufferFullError";
  }
}

/**
 * Passed to {@link ClientOptions.onTransportDrop} when the server initiates
 * a WebSocket close handshake by sending a close frame. The `code` and
 * `reason` fields are taken directly from the close frame.
 *
 * This is a protocol-level intentional close, distinct from an abrupt
 * network drop (which surfaces as a generic `Error`).
 *
 * @example
 * ```ts
 * onTransportDrop(err) {
 *   if (err instanceof ServerClosedError) {
 *     console.log(`server closed: code=${err.code} reason=${err.reason}`);
 *   }
 * }
 * ```
 */
export class ServerClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string) {
    const suffix = reason === "" ? "" : `, reason=${JSON.stringify(reason)}`;
    super(`wspulse: server closed connection: code=${code}${suffix}`);
    this.name = "ServerClosedError";
    this.code = code;
    this.reason = reason;
  }
}
