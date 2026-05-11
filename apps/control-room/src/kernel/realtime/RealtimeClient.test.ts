import { describe, expect, it, vi } from "vitest";

import { DATA_FIELDS_PATH } from "../api/apiPaths";
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
    const resources = new ResourceInvalidationController(bus);
    const sockets: FakeWebSocket[] = [];
    const client = new RealtimeClient({
      bridge: new RealtimeInvalidationBridge(resources),
      createSocket: (url, protocol) => {
        expect(url).toBe("ws://127.0.0.1:8765/v2/sessions/current/events/ws");
        expect(protocol).toBe("fullmag.live.v1");
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      url: "ws://127.0.0.1:8765/v2/sessions/current/events/ws",
    });

    client.connect();
    sockets[0].emit(
      "message",
      JSON.stringify({
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
      }),
    );

    expect(resources.getRevision("session:status")).toBe(8);
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(8);
    client.close();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
  });
});
