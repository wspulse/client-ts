/**
 * The application-layer message type for the wspulse wire protocol.
 * All fields are optional at the wire layer.
 */
export interface Message {
  event?: string;
  payload?: unknown;
}
