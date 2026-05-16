"use client";

import type { LiveRealtimeEvent } from "../types";
import { sessionApiPaths } from "../client/sessionPaths";

export const FULLMAG_LIVE_SUBPROTOCOL = "fullmag.live.v1";

type LiveRealtimeClientOptions = {
  baseUrl: string;
  onEvent: (event: LiveRealtimeEvent) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

export class LiveRealtimeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private closed = false;
  private lastSeenSeq = 0;
  private readonly options: LiveRealtimeClientOptions;

  constructor(options: LiveRealtimeClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private openSocket(): void {
    if (this.closed) {
      return;
    }
    if (
      this.socket &&
      (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      )
    ) {
      return;
    }
    const wsUrl = buildRealtimeWebSocketUrl(this.options.baseUrl, this.lastSeenSeq);
    const socket = new WebSocket(wsUrl, FULLMAG_LIVE_SUBPROTOCOL);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.options.onOpen?.();
    };

    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as LiveRealtimeEvent;
        if (typeof event.seq === "number") {
          this.lastSeenSeq = Math.max(this.lastSeenSeq, event.seq);
        }
        this.options.onEvent(event);
      } catch (error) {
        this.options.onError?.(
          error instanceof Error
            ? error
            : new Error("failed to parse realtime websocket event"),
        );
      }
    };

    socket.onerror = () => {
      this.options.onError?.(new Error("realtime websocket error"));
    };

    socket.onclose = () => {
      this.socket = null;
      this.options.onClose?.();
      if (this.closed) {
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        this.openSocket();
      }, this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        MAX_RECONNECT_DELAY_MS,
      );
    };
  }
}

function buildRealtimeWebSocketUrl(baseUrl: string, afterSeq: number): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const httpUrl = new URL(`${normalizedBase}${sessionApiPaths.events.ws}`);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  if (afterSeq > 0) {
    httpUrl.searchParams.set("after_seq", String(afterSeq));
  }
  return httpUrl.toString();
}
