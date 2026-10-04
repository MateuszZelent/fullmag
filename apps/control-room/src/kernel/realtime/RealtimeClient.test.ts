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
  it("does not open or retry a socket after the API preflight rejects replacement", async () => {
    const createSocket = vi.fn(() => new FakeWebSocket());
    const onScopeMismatch = vi.fn();
    const scheduleReconnect = vi.fn(() => () => {});
    const client = new RealtimeClient({
      beforeConnect: async () => false,
      bridge: { handleEvent: () => true },
      createSocket,
      onScopeMismatch,
      scheduleReconnect,
      url: "ws://localhost/v2/sessions/current/events/ws",
    });
    client.connect();
    await vi.waitFor(() => expect(onScopeMismatch).toHaveBeenCalledTimes(1));
    expect(createSocket).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
    client.close();
  });

  it("does not resurrect a socket after close during API preflight", async () => {
    let release: ((allowed: boolean) => void) | undefined;
    const check = new Promise<boolean>((resolve) => { release = resolve; });
    const beforeConnect = vi.fn(() => check);
    const createSocket = vi.fn(() => new FakeWebSocket());
    const client = new RealtimeClient({
      beforeConnect,
      bridge: { handleEvent: () => true },
      createSocket,
      url: "ws://localhost/v2/sessions/current/events/ws",
    });
    client.connect();
    await vi.waitFor(() => expect(beforeConnect).toHaveBeenCalledTimes(1));
    client.close();
    release?.(true);
    await check;
    await Promise.resolve();
    expect(createSocket).not.toHaveBeenCalled();
  });
  it("preserves the API instance companion protocol across reconnect", () => {
    const pin = "12345678-1234-4234-8234-123456789abc";
    const socket = new FakeWebSocket();
    const createSocket = vi.fn(() => socket);
    let reconnect: (() => void) | undefined;
    const client = new RealtimeClient({
      bridge: { handleEvent: () => true },
      createSocket,
      expectedApiInstance: pin,
      scheduleReconnect: (callback) => { reconnect = callback; return () => {}; },
      url: "ws://localhost/v2/sessions/current/events/ws",
    });
    client.connect();
    socket.emit("close", "");
    reconnect?.();
    expect(createSocket).toHaveBeenCalledTimes(2);
    for (const args of createSocket.mock.calls) {
      expect(args).toEqual(["ws://localhost/v2/sessions/current/events/ws", "fullmag.live.v1", `fullmag.api-instance.${pin}`]);
    }
    client.close();
  });
  it("rejects a hello from another request scope before accepting events", () => {
    const socket = new FakeWebSocket();
    const handleEvent = vi.fn(() => true);
    const onScopeMismatch = vi.fn();
    const client = new RealtimeClient({
      bridge: { handleEvent },
      createSocket: () => socket,
      expectedRequestScopeEpoch: "api-instance:2",
      onScopeMismatch,
      url: `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`,
    });

    client.connect();
    socket.emit("message", JSON.stringify({ type: "resource.batch_changed" }));
    expect(handleEvent).not.toHaveBeenCalled();

    socket.emit("message", JSON.stringify({
      payload: { request_scope_epoch: "api-instance:1" },
      type: "hello",
    }));
    expect(onScopeMismatch).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("accepts events only after a hello with the expected request scope", () => {
    const socket = new FakeWebSocket();
    const handleEvent = vi.fn(() => true);
    const client = new RealtimeClient({
      bridge: { handleEvent },
      createSocket: () => socket,
      expectedRequestScopeEpoch: "api-instance:2",
      url: `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`,
    });

    client.connect();
    socket.emit("message", JSON.stringify({
      payload: { request_scope_epoch: "api-instance:2" },
      type: "hello",
    }));
    socket.emit("message", JSON.stringify({ type: "resource.batch_changed" }));
    expect(handleEvent).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("closes a scoped socket before forwarding a message from another session", () => {
    const socket = new FakeWebSocket();
    const handleEvent = vi.fn(() => true);
    const onScopeMismatch = vi.fn();
    const client = new RealtimeClient({
      bridge: { handleEvent },
      createSocket: () => socket,
      expectedRequestScopeEpoch: "api-instance:2",
      expectedSessionId: "session-b",
      onScopeMismatch,
      url: `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`,
    });

    client.connect();
    socket.emit("message", JSON.stringify({
      payload: { request_scope_epoch: "api-instance:2" },
      session_id: "session-b",
      type: "hello",
    }));
    socket.emit("message", JSON.stringify({
      payload: { changes: [] },
      session_id: "session-a",
      type: "resource.batch_changed",
    }));

    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(onScopeMismatch).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

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

  it("reports actual socket disconnect and reconnect lifecycle", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const sockets: FakeWebSocket[] = [];
    const reconnectCallbacks: Array<() => void> = [];
    const statuses: KernelEventMap["session:status-changed"]["status"][] = [];
    const client = new RealtimeClient({
      bridge: new RealtimeInvalidationBridge(resources),
      createSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onStatusChange: (status) => statuses.push(status),
      scheduleReconnect: (callback) => {
        reconnectCallbacks.push(callback);
        return () => {};
      },
      url: `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`,
    });

    client.connect();
    sockets[0].emit("open", "");
    sockets[0].emit("close", "");
    reconnectCallbacks[0]();
    sockets[1].emit("open", "");

    expect(statuses).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connecting",
      "connected",
    ]);

    client.close();
    expect(statuses.at(-1)).toBe("idle");
  });

  it("notifies the kernel only after an established socket reconnects", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const sockets: FakeWebSocket[] = [];
    const reconnectCallbacks: Array<() => void> = [];
    const reconnected = vi.fn();
    const client = new RealtimeClient({
      bridge: new RealtimeInvalidationBridge(resources),
      createSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onReconnected: reconnected,
      scheduleReconnect: (callback) => {
        reconnectCallbacks.push(callback);
        return () => {};
      },
      url: `ws://127.0.0.1:8765${SESSION_EVENTS_WS_PATH}`,
    });

    client.connect();
    sockets[0].emit("open", "");
    expect(reconnected).not.toHaveBeenCalled();

    sockets[0].emit("close", "");
    reconnectCallbacks[0]();
    sockets[1].emit("open", "");
    expect(reconnected).toHaveBeenCalledTimes(1);

    client.close();
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
