import { describe, it, expect } from "vitest";
import { JSONCodec } from "../src/codec.js";
import type { Codec } from "../src/codec.js";
import type { Message } from "../src/message.js";

describe("JSONCodec", () => {
  it("encodes a message as JSON string", () => {
    const msg: Message = { event: "msg", payload: { text: "hello" } };
    const encoded = JSONCodec.encode(msg);
    expect(typeof encoded).toBe("string");
    expect(JSON.parse(encoded as string)).toEqual(msg);
  });

  it("decodes a JSON string into a message", () => {
    const json = '{"event":"msg","payload":{"text":"hello"}}';
    const msg = JSONCodec.decode(json);
    expect(msg.event).toBe("msg");
    expect(msg.payload).toEqual({ text: "hello" });
  });

  it("decodes a Uint8Array (UTF-8) into a message", () => {
    const json = '{"event":"test","payload":"binary"}';
    const bytes = new TextEncoder().encode(json);
    const msg = JSONCodec.decode(bytes);
    expect(msg.event).toBe("test");
    expect(msg.payload).toBe("binary");
  });

  it("has binaryType 'text'", () => {
    expect(JSONCodec.binaryType).toBe("text");
  });

  it("round-trips a message", () => {
    const msg: Message = { event: "sys", payload: [1, 2, 3] };
    const decoded = JSONCodec.decode(JSONCodec.encode(msg));
    expect(decoded).toEqual(msg);
  });

  it("throws on invalid JSON string", () => {
    expect(() => JSONCodec.decode("not json")).toThrow();
  });

  it("encodes a minimal message (no fields)", () => {
    const msg: Message = {};
    const encoded = JSONCodec.encode(msg);
    expect(JSON.parse(encoded as string)).toEqual({});
  });
});

describe("Codec interface", () => {
  it("accepts a custom binary codec", () => {
    const binaryCodec: Codec = {
      binaryType: "binary",
      encode(msg: Message): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(msg));
      },
      decode(data: string | Uint8Array): Message {
        const str =
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return JSON.parse(str) as Message;
      },
    };

    const msg: Message = { event: "bin", payload: { x: 1 } };
    const encoded = binaryCodec.encode(msg);
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = binaryCodec.decode(encoded);
    expect(decoded).toEqual(msg);
    expect(binaryCodec.binaryType).toBe("binary");
  });
});
