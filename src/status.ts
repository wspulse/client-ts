/**
 * Selected WebSocket close status codes from RFC 6455 §7.4.
 *
 * `StatusCode` is a plain number — it is not an exhaustive enum. The
 * private-use range `4000`–`4999` is reserved by RFC 6455 for application
 * definitions, so values outside this object are valid.
 *
 * Numeric values are identical across all wspulse SDKs.
 */
export type StatusCode = number;

// Use an object with `as const` so the values are both readable as
// `StatusCode.GoingAway` and usable wherever a `number` is expected.
export const StatusCode = {
  /** Normal, intentional close (1000). */
  NormalClosure: 1000,

  /** Endpoint is going away — server shutting down or browser tab closing (1001). */
  GoingAway: 1001,

  /** Protocol error (1002). */
  ProtocolError: 1002,

  /** Endpoint received a frame type it cannot accept (1003). */
  UnsupportedData: 1003,

  /** Received data not consistent with the message type (1007). */
  InvalidFramePayloadData: 1007,

  /** Endpoint policy violation (1008). */
  PolicyViolation: 1008,

  /** Message too large to process (1009). */
  MessageTooBig: 1009,

  /** Client expected a required extension the server did not return (1010). */
  MandatoryExtension: 1010,

  /** Server encountered an unexpected condition (1011). */
  InternalError: 1011,

  // --- Local-only sentinels (MUST NOT be sent on the wire, per RFC 6455 §7.4.1) ---

  /** No status code was present in the close frame (1005, local-only). */
  NoStatusReceived: 1005,

  /** Connection closed abnormally without a close frame (1006, local-only). */
  AbnormalClosure: 1006,

  /** TLS handshake failure (1015, local-only). */
  TLSHandshake: 1015,
} as const;
