import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveRealtimeClient } from "../LiveRealtimeClient";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("LiveRealtimeClient", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    globalThis.WebSocket = originalWebSocket;
  });

  it("does not open a second socket while the first socket is still connecting", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const client = new LiveRealtimeClient({
      baseUrl: "http://localhost:3000",
      onEvent: vi.fn(),
    });

    client.connect();
    client.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
