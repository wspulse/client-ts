/**
 * The minimal transport unit for the wspulse wire protocol.
 * All fields are optional at the wire layer.
 */
export interface Frame {
  event?: string;
  payload?: unknown;
}
