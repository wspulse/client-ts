import { describe, it, expect } from "vitest";
import { JSONCodec } from "../src/codec.js";
import type { Codec } from "../src/codec.js";
import type { Frame } from "../src/frame.js";

describe("JSONCodec", () => {
  it("encodes a frame as JSON string", () => {
    const frame: Frame = { event: "msg", payload: { text: "hello" } };
    const encoded = JSONCodec.encode(frame);
    expect(typeof encoded).toBe("string");
    expect(JSON.parse(encoded as string)).toEqual(frame);
  });

  it("decodes a JSON string into a frame", () => {
    const json = '{"event":"msg","payload":{"text":"hello"}}';
    const frame = JSONCodec.decode(json);
    expect(frame.event).toBe("msg");
    expect(frame.payload).toEqual({ text: "hello" });
  });

  it("decodes a Uint8Array (UTF-8) into a frame", () => {
    const json = '{"event":"test","payload":"binary"}';
    const bytes = new TextEncoder().encode(json);
    const frame = JSONCodec.decode(bytes);
    expect(frame.event).toBe("test");
    expect(frame.payload).toBe("binary");
  });

  it("has binaryType 'text'", () => {
    expect(JSONCodec.binaryType).toBe("text");
  });

  it("round-trips a frame", () => {
    const frame: Frame = { event: "sys", payload: [1, 2, 3] };
    const decoded = JSONCodec.decode(JSONCodec.encode(frame));
    expect(decoded).toEqual(frame);
  });

  it("throws on invalid JSON string", () => {
    expect(() => JSONCodec.decode("not json")).toThrow();
  });

  it("encodes a minimal frame (no fields)", () => {
    const frame: Frame = {};
    const encoded = JSONCodec.encode(frame);
    expect(JSON.parse(encoded as string)).toEqual({});
  });
});

describe("Codec interface", () => {
  it("accepts a custom binary codec", () => {
    const binaryCodec: Codec = {
      binaryType: "binary",
      encode(frame: Frame): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(frame));
      },
      decode(data: string | Uint8Array): Frame {
        const str =
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return JSON.parse(str) as Frame;
      },
    };

    const frame: Frame = { event: "bin", payload: { x: 1 } };
    const encoded = binaryCodec.encode(frame);
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = binaryCodec.decode(encoded);
    expect(decoded).toEqual(frame);
    expect(binaryCodec.binaryType).toBe("binary");
  });
});
