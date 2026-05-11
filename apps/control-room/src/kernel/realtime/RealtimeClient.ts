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
  url: string;
}

export class RealtimeClient {
  private socket: RealtimeWebSocketLike | null = null;
  private readonly handleMessage = (event: MessageEventLike) => {
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>;
      this.bridge.handleEvent(parsed);
    } catch {
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
