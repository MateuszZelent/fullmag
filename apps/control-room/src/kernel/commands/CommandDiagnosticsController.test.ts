import { describe, expect, it, vi } from "vitest";

import { CommandDiagnosticsController } from "./CommandDiagnosticsController";

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

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

  it("publishes changes to subscribers and clears entries", async () => {
    const diagnostics = new CommandDiagnosticsController();
    const listener = vi.fn();
    const unsubscribe = diagnostics.subscribe(listener);

    diagnostics.record({
      commandId: "study.run",
      source: "shortcut",
      sourceDetail: "global",
      status: "submitted",
    });

    await nextMicrotask();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnostics.getVersion()).toBe(1);
    expect(diagnostics.list()).toHaveLength(1);

    diagnostics.clear();
    await nextMicrotask();

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

  it("coalesces synchronous records into one subscriber notification", async () => {
    const diagnostics = new CommandDiagnosticsController();
    const listener = vi.fn();
    diagnostics.subscribe(listener);

    diagnostics.record({
      commandId: "study.run",
      source: "ribbon",
      status: "submitted",
      timestampMs: 10,
    });
    diagnostics.record({
      commandId: "study.compute-fields",
      source: "ribbon",
      status: "submitted",
      timestampMs: 20,
    });

    expect(listener).not.toHaveBeenCalled();
    await nextMicrotask();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnostics.getVersion()).toBe(1);
    expect(diagnostics.listNewestFirst().map((entry) => entry.commandId)).toEqual([
      "study.compute-fields",
      "study.run",
    ]);
  });

});
