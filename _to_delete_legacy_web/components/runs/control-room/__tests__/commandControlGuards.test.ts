import { describe, expect, it } from "vitest";

import {
  canIssueSolverControlCommand,
  commandBlockedReason,
  solverControlRequiresRuntimeAcceptance,
  solverControlStatusAllows,
} from "../commandControlGuards";

const base = {
  interactiveEnabled: true,
  runtimeCanAcceptCommands: true,
  commandBusy: false,
  commandMessage: null,
};

describe("solver control command guards", () => {
  it("keeps running interrupt controls available when command acceptance is stale", () => {
    for (const action of ["pause", "stop", "skip"] as const) {
      expect(
        canIssueSolverControlCommand({
          ...base,
          action,
          runtimeCanAcceptCommands: false,
          workspaceStatus: "running",
        }),
      ).toBe(true);
      expect(solverControlRequiresRuntimeAcceptance(action, "running")).toBe(false);
    }
  });

  it("does not allow compute/run when the runtime cannot accept new work", () => {
    expect(
      canIssueSolverControlCommand({
        ...base,
        action: "run",
        runtimeCanAcceptCommands: false,
        workspaceStatus: "awaiting_command",
        awaitingCommand: true,
      }),
    ).toBe(false);
    expect(solverControlRequiresRuntimeAcceptance("run", "awaiting_command")).toBe(true);
  });

  it("keeps paused resume available when command acceptance is stale", () => {
    expect(
      canIssueSolverControlCommand({
        ...base,
        action: "run",
        runtimeCanAcceptCommands: false,
        workspaceStatus: "paused",
      }),
    ).toBe(true);
    expect(solverControlRequiresRuntimeAcceptance("run", "paused")).toBe(false);
  });

  it("allows stop while waiting for compute but not pause or skip", () => {
    expect(solverControlStatusAllows("stop", "waiting_for_compute")).toBe(true);
    expect(solverControlStatusAllows("pause", "waiting_for_compute")).toBe(false);
    expect(solverControlStatusAllows("skip", "waiting_for_compute")).toBe(false);
  });

  it("does not report stale runtime acceptance as a block for running interrupts", () => {
    expect(
      commandBlockedReason(
        {
          ...base,
          runtimeCanAcceptCommands: false,
          workspaceStatus: "running",
        },
        "pause",
        false,
      ),
    ).toBeNull();
  });
});
