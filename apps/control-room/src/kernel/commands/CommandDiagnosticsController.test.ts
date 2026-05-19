import { describe, expect, it, vi } from "vitest";

import { CommandDiagnosticsController } from "./CommandDiagnosticsController";

describe("CommandDiagnosticsController", () => {
  it("records bounded command audit entries", () => {
    const diagnostics = new CommandDiagnosticsController(2);

    diagnostics.record({
      commandId: "study.run",
      source: "ribbon",
      sourceDetail: "study",
      status: "submitted",
      timestampMs: 10,
    });
    diagnostics.record({
      commandId: "study.compute-fields",
      message: "Compute fields command accepted.",
      source: "inspector",
      sourceDetail: "study",
      status: "completed",
      timestampMs: 20,
    });
    diagnostics.record({
      commandId: "study.compute-energies",
      disabledReason: "Runtime state is unavailable.",
      source: "menu",
      sourceDetail: "app-menu",
      status: "disabled",
      timestampMs: 30,
    });

    expect(diagnostics.list()).toMatchObject([
      {
        commandId: "study.compute-fields",
        message: "Compute fields command accepted.",
        source: "inspector",
        sourceDetail: "study",
        status: "completed",
      },
      {
        commandId: "study.compute-energies",
        disabledReason: "Runtime state is unavailable.",
        source: "menu",
        sourceDetail: "app-menu",
        status: "disabled",
      },
    ]);
  });

  it("publishes changes to subscribers and clears entries", () => {
    const diagnostics = new CommandDiagnosticsController();
    const listener = vi.fn();
    const unsubscribe = diagnostics.subscribe(listener);

    diagnostics.record({
      commandId: "study.run",
      source: "shortcut",
      sourceDetail: "global",
      status: "submitted",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnostics.getVersion()).toBe(1);
    expect(diagnostics.list()).toHaveLength(1);

    diagnostics.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(diagnostics.list()).toEqual([]);

    unsubscribe();
    diagnostics.record({
      commandId: "study.run",
      source: "shortcut",
      status: "submitted",
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
