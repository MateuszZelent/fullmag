import { describe, expect, it, vi } from "vitest";

import { RequestDiagnosticsController } from "./RequestDiagnosticsController";

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("RequestDiagnosticsController", () => {
  it("records bounded request outcomes in order", () => {
    const diagnostics = new RequestDiagnosticsController(2);

    diagnostics.record({
      durationMs: 10,
      method: "GET",
      outcome: "ok",
      path: "/first",
      requestId: "req-1",
      status: 200,
    });
    diagnostics.record({
      durationMs: 20,
      method: "GET",
      outcome: "error",
      path: "/second",
      requestId: "req-2",
      status: 500,
    });
    diagnostics.record({
      durationMs: 30,
      method: "GET",
      outcome: "network-error",
      path: "/third",
      requestId: "req-3",
      status: null,
    });

    expect(diagnostics.list().map((entry) => entry.requestId)).toEqual([
      "req-2",
      "req-3",
    ]);
    expect(diagnostics.list()[0]).toMatchObject({
      byteLength: null,
      channel: "http",
      direction: "rx",
    });
  });

  it("publishes changes to subscribers and clears entries", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const listener = vi.fn();
    const unsubscribe = diagnostics.subscribe(listener);

    diagnostics.record({
      byteLength: 128.4,
      channel: "websocket",
      direction: "tx",
      method: "WS",
      outcome: "sent",
      path: "/v2/sessions/current/events/ws",
      requestId: "websocket",
    });

    await nextMicrotask();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnostics.getVersion()).toBe(1);
    expect(diagnostics.list()[0]).toMatchObject({
      byteLength: 128,
      channel: "websocket",
      direction: "tx",
      outcome: "sent",
    });

    diagnostics.clear();
    await nextMicrotask();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(diagnostics.list()).toEqual([]);

    unsubscribe();
    diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "/after-unsubscribe",
      requestId: "req-4",
      status: 200,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reuses newest-first snapshots until diagnostics change", () => {
    const diagnostics = new RequestDiagnosticsController();

    diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "/first",
      requestId: "req-1",
      status: 200,
      timestampMs: 10,
    });
    diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "/second",
      requestId: "req-2",
      status: 200,
      timestampMs: 20,
    });

    const firstSnapshot = diagnostics.listNewestFirst();

    expect(diagnostics.listNewestFirst()).toBe(firstSnapshot);
    expect(firstSnapshot.map((entry) => entry.requestId)).toEqual([
      "req-2",
      "req-1",
    ]);

    diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "/third",
      requestId: "req-3",
      status: 200,
      timestampMs: 30,
    });

    const secondSnapshot = diagnostics.listNewestFirst();

    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(secondSnapshot.map((entry) => entry.requestId)).toEqual([
      "req-3",
      "req-2",
      "req-1",
    ]);

    diagnostics.clear();

    expect(diagnostics.listNewestFirst()).toEqual([]);
    expect(diagnostics.listNewestFirst()).not.toBe(secondSnapshot);
  });

  it("coalesces synchronous records into one subscriber notification", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const listener = vi.fn();
    diagnostics.subscribe(listener);

    diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "/first",
      requestId: "req-1",
      status: 200,
      timestampMs: 10,
    });
    diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "/second",
      requestId: "req-2",
      status: 200,
      timestampMs: 20,
    });

    expect(listener).not.toHaveBeenCalled();
    await nextMicrotask();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnostics.getVersion()).toBe(1);
    expect(diagnostics.listNewestFirst().map((entry) => entry.requestId)).toEqual([
      "req-2",
      "req-1",
    ]);
  });

  it("aggregates repeated websocket receive diagnostics inside the summary window", () => {
    const diagnostics = new RequestDiagnosticsController();

    diagnostics.record({
      byteLength: 100,
      channel: "websocket",
      direction: "rx",
      messageType: "resource.batch_changed",
      method: "WS",
      outcome: "ok",
      path: "/v2/sessions/current/events/ws",
      requestId: "websocket",
      timestampMs: 1_000,
    });
    diagnostics.record({
      byteLength: 120,
      channel: "websocket",
      direction: "rx",
      messageType: "resource.batch_changed",
      method: "WS",
      outcome: "ok",
      path: "/v2/sessions/current/events/ws",
      requestId: "websocket",
      timestampMs: 1_300,
    });

    expect(diagnostics.list()).toHaveLength(1);
    expect(diagnostics.list()[0]).toMatchObject({
      byteLength: 220,
      detail: "message (x2 over 300ms)",
      messageType: "resource.batch_changed",
      timestampMs: 1_300,
    });
  });

});
