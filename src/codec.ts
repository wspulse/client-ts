import type { Frame } from "./frame.js";

/**
 * Codec encodes and decodes {@link Frame}s for WebSocket transmission.
 *
 * Mirrors the `wspulse.Codec` interface from the Go `core` module.
 * Implement this interface to use a custom wire format (e.g. Protocol Buffers).
 *
 * The built-in {@link JSONCodec} is the default and sends JSON text frames.
 */
export interface Codec {
  /**
   * Serialize a Frame into data ready to be sent over the WebSocket.
   *
   * Return a `string` for text frames or `Uint8Array` for binary frames.
   * The return type must be consistent with {@link binaryType}.
   */
  encode(frame: Frame): string | Uint8Array;

  /**
   * Deserialize received WebSocket data into a Frame.
   *
   * `data` is a `string` when `binaryType` is `"text"`, or `Uint8Array`
   * when `binaryType` is `"binary"`.
   */
  decode(data: string | Uint8Array): Frame;

  /**
   * The WebSocket frame type this codec uses.
   *
   * - `"text"` — text frames (opcode 1). `encode()` must return `string`.
   * - `"binary"` — binary frames (opcode 2). `encode()` must return `Uint8Array`.
   *
   * This also controls the browser WebSocket `binaryType` property:
   * `"binary"` sets it to `"arraybuffer"` so binary data arrives as
   * `ArrayBuffer` instead of `Blob`.
   */
  binaryType: "text" | "binary";
}

/**
 * Default JSON codec. Frames are encoded as JSON text frames.
 *
 * This matches the default `JSONCodec` in the Go `core` module.
 */
export const JSONCodec: Codec = {
  binaryType: "text",

  encode(frame: Frame): string {
    return JSON.stringify(frame);
  },

  decode(data: string | Uint8Array): Frame {
    const str =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    return JSON.parse(str) as Frame;
  },
};
