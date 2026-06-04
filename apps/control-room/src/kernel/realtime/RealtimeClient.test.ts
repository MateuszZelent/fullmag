import { describe, expect, it, vi } from "vitest";

import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import { DATA_FIELDS_PATH, SESSION_EVENTS_WS_PATH } from "../api/apiPaths";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

import { RealtimeClient, type RealtimeWebSocketLike } from "./RealtimeClient";
import { RealtimeInvalidationBridge } from "./RealtimeInvalidationBridge";

class FakeWebSocket implements RealtimeWebSocketLike {
  readonly close = vi.fn();
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

describe("RealtimeClient", () => {
  it("connects to the v2 realtime endpoint and invalidates resources from events", () => {
    const bus = new EventBus<KernelEventMap>();
    const diagnostics = new RequestDiagnosticsController();
    const resources = new ResourceInvalidationController(bus);
    const sockets: FakeWebSocket[] = [];
    const eventsUrl = `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`;
    const client = new RealtimeClient({
      bridge: new RealtimeInvalidationBridge(resources),
      createSocket: (url, protocol) => {
        expect(url).toBe(eventsUrl);
        expect(protocol).toBe("fullmag.live.v1");
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      diagnostics,
      url: eventsUrl,
    });

    client.connect();
    const message = JSON.stringify({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            resource: "fields",
            revision: 8,
          },
        ],
      },
      type: "resource.batch_changed",
    });
    sockets[0].emit("message", message);

    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(8);
    expect(diagnostics.list()).toMatchObject([
      {
        channel: "websocket",
        direction: "tx",
        messageType: "fullmag.live.v1",
        outcome: "sent",
        path: SESSION_EVENTS_WS_PATH,
      },
      {
        byteLength: new TextEncoder().encode(message).byteLength,
        channel: "websocket",
        direction: "rx",
        detail:
          "immediate changes=fields@8->/v2/sessions/current/data/fields",
        messageType: "resource.batch_changed",
        outcome: "ok",
        path: SESSION_EVENTS_WS_PATH,
      },
    ]);
    client.close();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
  });

  it("reconnects after the websocket closes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const sockets: FakeWebSocket[] = [];
    const reconnectCallbacks: Array<() => void> = [];
    const eventsUrl = `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`;
    const client = new RealtimeClient({
      bridge: new RealtimeInvalidationBridge(resources),
      createSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      scheduleReconnect: (callback) => {
        reconnectCallbacks.push(callback);
        return () => {};
      },
      url: eventsUrl,
    });

    client.connect();
    sockets[0].emit("close", "");

    expect(reconnectCallbacks).toHaveLength(1);
    reconnectCallbacks[0]();

    expect(sockets).toHaveLength(2);

    client.close();
    sockets[1].emit("close", "");
    expect(reconnectCallbacks).toHaveLength(1);
  });

  it("reconnects with the last processed sequence cursor", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const sockets: FakeWebSocket[] = [];
    const socketUrls: string[] = [];
    const reconnectCallbacks: Array<() => void> = [];
    const eventsUrl = `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`;
    const client = new RealtimeClient({
      bridge: new RealtimeInvalidationBridge(resources),
      createSocket: (url) => {
        socketUrls.push(url);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      scheduleReconnect: (callback) => {
        reconnectCallbacks.push(callback);
        return () => {};
      },
      url: eventsUrl,
    });

    client.connect();
    sockets[0].emit(
      "message",
      JSON.stringify({
        payload: { current_seq: 14 },
        seq: 14,
        type: "heartbeat",
      }),
    );
    sockets[0].emit("close", "");
    reconnectCallbacks[0]();

    expect(socketUrls).toEqual([
      eventsUrl,
      `${eventsUrl}?after_seq=14`,
    ]);
  });
});
