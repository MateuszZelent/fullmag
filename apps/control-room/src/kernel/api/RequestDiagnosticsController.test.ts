import { describe, expect, it } from "vitest";

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
  });
});
