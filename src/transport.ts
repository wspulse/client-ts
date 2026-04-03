/**
 * Minimal WebSocket interface consumed by the client.
 *
 * Browser `WebSocket` and the `ws` package both satisfy this shape.
 * This decouples the client from any specific WebSocket implementation.
 *
 * Exported so tests can provide mock implementations via the `_dialer`
 * option without depending on a real WebSocket library.
 */
export interface Transport {
  readonly readyState: number;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array | Blob): void;
  close(code?: number, reason?: string): void;
  /** Node.js `ws` library: register event listener (ping, pong, etc.). */
  on?(event: string, listener: (...args: unknown[]) => void): void;
  /** Node.js `ws` library: remove event listener. */
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  /** Node.js `ws` library: send a WebSocket Ping frame. */
  ping?(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;
  /** Node.js `ws` library: forcefully destroy the socket without close handshake. */
  terminate?(): void;
}
