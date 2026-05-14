import type { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";

export interface RealtimeWebSocketLike {
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  close(): void;
  removeEventListener(type: string, listener: (event: MessageEventLike) => void): void;
}

export const FULLMAG_LIVE_SUBPROTOCOL = "fullmag.live.v1";

interface MessageEventLike {
  data: string;
}

interface RealtimeBridge {
  handleEvent(event: Record<string, unknown>): boolean;
}

interface RealtimeClientOptions {
  bridge: RealtimeBridge;
  createSocket?: (url: string, protocol: string) => RealtimeWebSocketLike;
  diagnostics?: RequestDiagnosticsController;
  url: string;
}

export class RealtimeClient {
  private socket: RealtimeWebSocketLike | null = null;
  private readonly handleMessage = (event: MessageEventLike) => {
    const byteLength = byteLengthFromText(event.data);
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>;
      this.options.diagnostics?.record({
        byteLength,
        channel: "websocket",
        detail: "message",
        direction: "rx",
        durationMs: null,
        messageType:
          typeof parsed.type === "string" ? parsed.type : "unknown-message",
        method: "WS",
        outcome: "ok",
        path: pathFromUrl(this.options.url),
        requestId: "websocket",
        status: null,
      });
      this.bridge.handleEvent(parsed);
    } catch {
      this.options.diagnostics?.record({
        byteLength,
        channel: "websocket",
        detail: "invalid json",
        direction: "rx",
        durationMs: null,
        messageType: "invalid-json",
        method: "WS",
        outcome: "error",
        path: pathFromUrl(this.options.url),
        requestId: "websocket",
        status: null,
      });
      return;
    }
  };

  constructor(private readonly options: RealtimeClientOptions) {}

  private get bridge(): RealtimeBridge {
    return this.options.bridge;
  }

  connect(): void {
    if (this.socket) {
      return;
    }

    const socket = this.options.createSocket?.(
      this.options.url,
      FULLMAG_LIVE_SUBPROTOCOL,
    ) ?? new WebSocket(this.options.url, FULLMAG_LIVE_SUBPROTOCOL);
    this.options.diagnostics?.record({
      byteLength: byteLengthFromText(FULLMAG_LIVE_SUBPROTOCOL),
      channel: "websocket",
      detail: "connect",
      direction: "tx",
      durationMs: null,
      messageType: FULLMAG_LIVE_SUBPROTOCOL,
      method: "WS",
      outcome: "sent",
      path: pathFromUrl(this.options.url),
      requestId: "websocket",
      status: null,
    });
    socket.addEventListener("message", this.handleMessage);
    this.socket = socket;
  }

  close(): void {
    if (!this.socket) {
      return;
    }

    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.close();
    this.socket = null;
  }
}

function byteLengthFromText(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
