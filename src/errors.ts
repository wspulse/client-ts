export class ConnectionClosedError extends Error {
  constructor() {
    super("wspulse: connection is closed");
    this.name = "ConnectionClosedError";
  }
}

export class RetriesExhaustedError extends Error {
  constructor() {
    super("wspulse: max reconnect retries exhausted");
    this.name = "RetriesExhaustedError";
  }
}

export class ConnectionLostError extends Error {
  constructor() {
    super("wspulse: connection lost");
    this.name = "ConnectionLostError";
  }
}
