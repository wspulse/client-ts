import { describe, it, expect } from "vitest";
import { normalizeScheme } from "../src/client.js";

describe("normalizeScheme", () => {
  // ── passthrough ────────────────────────────────────────────────────────────

  it("passes through ws:// unchanged", () => {
    expect(normalizeScheme("ws://localhost:8080/ws")).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("passes through wss:// unchanged", () => {
    expect(normalizeScheme("wss://example.com/ws")).toBe(
      "wss://example.com/ws",
    );
  });

  // ── conversion ─────────────────────────────────────────────────────────────

  it("converts http:// to ws://", () => {
    const result = normalizeScheme("http://localhost:8080/ws");
    expect(result).toBe("ws://localhost:8080/ws");
  });

  it("converts https:// to wss://", () => {
    const result = normalizeScheme("https://example.com/ws");
    expect(result).toBe("wss://example.com/ws");
  });

  it("converts http:// with port", () => {
    const result = normalizeScheme("http://127.0.0.1:9090/path");
    expect(result).toBe("ws://127.0.0.1:9090/path");
  });

  it("converts https:// with port and query", () => {
    const result = normalizeScheme("https://host:9443/ws?token=abc");
    expect(result).toBe("wss://host:9443/ws?token=abc");
  });

  // ── error: missing scheme ──────────────────────────────────────────────────

  it("throws on missing scheme", () => {
    expect(() => normalizeScheme("://no-scheme")).toThrow(
      "wspulse: url must include scheme",
    );
  });

  // ── error: malformed URL with recognized scheme ────────────────────────────

  it("throws 'invalid url' for malformed URL with recognized scheme", () => {
    expect(() => normalizeScheme("http://[invalid")).toThrow(
      "wspulse: invalid url",
    );
  });

  // ── error: missing host (scheme without "//") ──────────────────────────────

  it("throws on ws:foo (no '//')", () => {
    expect(() => normalizeScheme("ws:foo")).toThrow(
      "wspulse: url must include host",
    );
  });

  it("throws on http:foo (no '//')", () => {
    expect(() => normalizeScheme("http:foo")).toThrow(
      "wspulse: url must include host",
    );
  });

  // ── error: unsupported scheme ──────────────────────────────────────────────

  it("throws on unsupported scheme (ftp://)", () => {
    expect(() => normalizeScheme("ftp://host/path")).toThrow(
      'wspulse: unsupported url scheme "ftp"',
    );
  });

  it("throws 'unsupported scheme' for malformed URL with unsupported scheme", () => {
    expect(() => normalizeScheme("ftp://[invalid")).toThrow(
      'wspulse: unsupported url scheme "ftp"',
    );
  });
});
