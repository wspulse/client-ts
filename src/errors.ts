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
 * discarding the message, or closing the connection.
 */
export class SendBufferFullError extends Error {
  constructor() {
    super("wspulse: send buffer full");
    this.name = "SendBufferFullError";
  }
}
