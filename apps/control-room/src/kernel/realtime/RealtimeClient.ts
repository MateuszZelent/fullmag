import type { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import type { KernelEventMap } from "../events/eventTypes";

import {
  realtimeReconnectDelayMs,
  updateRealtimeCommunicationPolicy,
} from "./communicationPolicy";

export interface RealtimeWebSocketLike {
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  close(): void;
  removeEventListener(type: string, listener: (event: MessageEventLike) => void): void;
}

const FULLMAG_LIVE_SUBPROTOCOL = "fullmag.live.v1";

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
  onStatusChange?: (status: RealtimeConnectionStatus) => void;
  scheduleReconnect?: (callback: () => void, delayMs: number) => () => void;
  url: string;
}

export type RealtimeConnectionStatus =
  KernelEventMap["session:status-changed"]["status"];

export class RealtimeClient {
  private closedByClient = false;
  private lastSeenSeq: number | null = null;
  private reconnectCancel: (() => void) | null = null;
  private socket: RealtimeWebSocketLike | null = null;
  private readonly handleClose = () => {
    const socket = this.socket;
    if (socket) {
      socket.removeEventListener("message", this.handleMessage);
      socket.removeEventListener("open", this.handleOpen);
      socket.removeEventListener("close", this.handleClose);
    }
    this.socket = null;
    if (!this.closedByClient) {
      this.notifyStatus("disconnected");
      this.scheduleReconnect();
    }
  };
  private readonly handleOpen = () => {
    this.notifyStatus("connected");
  };
  private readonly handleMessage = (event: MessageEventLike) => {
    const byteLength = byteLengthFromText(event.data);
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>;
      this.options.diagnostics?.record({
        byteLength,
        channel: "websocket",
        detail: realtimeDiagnosticDetail(parsed),
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
      updateRealtimePolicyFromEvent(parsed);
      this.bridge.handleEvent(parsed);
      this.recordSequence(parsed);
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
    this.closedByClient = false;
    this.reconnectCancel?.();
    this.reconnectCancel = null;
    this.notifyStatus("connecting");

    const url = this.connectionUrl();
    const socket = this.options.createSocket?.(
      url,
      FULLMAG_LIVE_SUBPROTOCOL,
    ) ?? new WebSocket(url, FULLMAG_LIVE_SUBPROTOCOL);
    this.options.diagnostics?.record({
      byteLength: byteLengthFromText(FULLMAG_LIVE_SUBPROTOCOL),
      channel: "websocket",
      detail: "connect",
      direction: "tx",
      durationMs: null,
      messageType: FULLMAG_LIVE_SUBPROTOCOL,
      method: "WS",
      outcome: "sent",
      path: pathFromUrl(url),
      requestId: "websocket",
      status: null,
    });
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("close", this.handleClose);
    this.socket = socket;
  }

  close(): void {
    this.closedByClient = true;
    this.reconnectCancel?.();
    this.reconnectCancel = null;
    if (!this.socket) {
      this.notifyStatus("idle");
      return;
    }

    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("close", this.handleClose);
    this.socket.close();
    this.socket = null;
    this.notifyStatus("idle");
  }

  private notifyStatus(status: RealtimeConnectionStatus): void {
    this.options.onStatusChange?.(status);
  }

  private scheduleReconnect(): void {
    if (this.reconnectCancel) return;
    const schedule =
      this.options.scheduleReconnect ??
      ((callback: () => void, delayMs: number) => {
        const timeoutId = setTimeout(callback, delayMs);
        return () => clearTimeout(timeoutId);
      });
    this.reconnectCancel = schedule(() => {
      this.reconnectCancel = null;
      if (!this.closedByClient) {
        this.connect();
      }
    }, realtimeReconnectDelayMs());
  }

  private connectionUrl(): string {
    if (this.lastSeenSeq === null) {
      return this.options.url;
    }

    try {
      const url = new URL(this.options.url);
      url.searchParams.set("after_seq", String(this.lastSeenSeq));
      return url.toString();
    } catch {
      const separator = this.options.url.includes("?") ? "&" : "?";
      return `${this.options.url}${separator}after_seq=${this.lastSeenSeq}`;
    }
  }

  private recordSequence(event: Record<string, unknown>): void {
    const seq = event.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
      return;
    }

    this.lastSeenSeq = Math.max(this.lastSeenSeq ?? 0, seq);
  }
}

function updateRealtimePolicyFromEvent(event: Record<string, unknown>): void {
  if (event.type !== "hello") return;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  updateRealtimeCommunicationPolicy(payload?.communication_policy);
}

function realtimeDiagnosticDetail(event: Record<string, unknown>): string {
  if (event.type !== "resource.batch_changed") {
    return "message";
  }
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  const changeSummary = changes
    .slice(0, 6)
    .map((change) => {
      if (!change || typeof change !== "object") return "unknown";
      const record = change as Record<string, unknown>;
      const resource = typeof record.resource === "string" ? record.resource : "?";
      const resourceId =
        typeof record.resource_id === "string" ? `:${record.resource_id}` : "";
      const revision =
        typeof record.revision === "number" || typeof record.revision === "string"
          ? `@${record.revision}`
          : "";
      const quantityIds = Array.isArray(record.quantity_ids)
        ? record.quantity_ids
            .filter((value): value is string => typeof value === "string")
            .join(",")
        : "";
      const quantitySuffix = quantityIds ? `[${quantityIds}]` : "";
      const fetch =
        typeof record.recommended_fetch === "string"
          ? `->${record.recommended_fetch}`
          : "";
      const broad = record.broad === true ? ":broad" : "";
      return `${resource}${resourceId}${quantitySuffix}${broad}${revision}${fetch}`;
    })
    .join(" ");
  const truncated = changes.length > 6 ? ` +${changes.length - 6}` : "";
  const coalesced = payload?.coalesced === true ? "coalesced" : "immediate";
  const windowMs =
    typeof payload?.window_ms === "number" ? ` window=${payload.window_ms}ms` : "";
  const seq =
    typeof event.seq === "number" || typeof event.seq === "string"
      ? ` seq=${event.seq}`
      : "";
  return `${coalesced}${windowMs}${seq} changes=${changeSummary}${truncated}`.trim();
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
