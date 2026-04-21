import type { Message } from "./message.js";

/**
 * Codec encodes and decodes {@link Message}s for WebSocket transmission.
 *
 * Mirrors the `wspulse.Codec` interface from the Go `core` module.
 * Implement this interface to use a custom wire format (e.g. Protocol Buffers).
 *
 * The built-in {@link JSONCodec} is the default and sends JSON text WebSocket frames.
 */
export interface Codec {
  /**
   * Serialize a Message into data ready to be sent over the WebSocket.
   *
   * Return a `string` for text WebSocket frames or `Uint8Array` for binary
   * WebSocket frames. The return type must be consistent with {@link binaryType}.
   */
  encode(msg: Message): string | Uint8Array;

  /**
   * Deserialize received WebSocket data into a Message.
   *
   * `data` is a `string` when `binaryType` is `"text"`, or `Uint8Array`
   * when `binaryType` is `"binary"`.
   */
  decode(data: string | Uint8Array): Message;

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
 * Default JSON codec. Messages are encoded as JSON text WebSocket frames.
 *
 * This matches the default `JSONCodec` in the Go `core` module.
 */
export const JSONCodec: Codec = {
  binaryType: "text",

  encode(msg: Message): string {
    return JSON.stringify(msg);
  },

  decode(data: string | Uint8Array): Message {
    const str =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    return JSON.parse(str) as Message;
  },
};
