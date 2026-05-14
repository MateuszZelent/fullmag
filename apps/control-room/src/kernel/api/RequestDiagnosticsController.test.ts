import { describe, expect, it, vi } from "vitest";

import { RequestDiagnosticsController } from "./RequestDiagnosticsController";

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

  it("publishes changes to subscribers and clears entries", () => {
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

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnostics.getVersion()).toBe(1);
    expect(diagnostics.list()[0]).toMatchObject({
      byteLength: 128,
      channel: "websocket",
      direction: "tx",
      outcome: "sent",
    });

    diagnostics.clear();
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
});
