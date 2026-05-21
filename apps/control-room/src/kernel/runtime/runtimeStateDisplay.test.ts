import { describe, expect, it } from "vitest";

import {
  formatRuntimeStateLabel,
  isRuntimeStateActive,
  resolveEffectiveRuntimeState,
} from "./runtimeStateDisplay";

describe("runtimeStateDisplay", () => {
  it("prefers detailed solver runtime_state over the thin session solver state", () => {
    expect(
      resolveEffectiveRuntimeState({
        detailedRuntimeState: "waiting_for_compute",
        sessionSolverState: "running",
      }),
    ).toBe("waiting_for_compute");
  });

  it("formats backend runtime states as user-facing labels", () => {
    expect(formatRuntimeStateLabel("waiting_for_compute")).toBe(
      "Waiting for compute",
    );
    expect(formatRuntimeStateLabel("awaiting_command")).toBe("Awaiting command");
  });

  it("treats waiting_for_compute as ready but not actively computing", () => {
    expect(isRuntimeStateActive("running")).toBe(true);
    expect(isRuntimeStateActive("waiting_for_compute")).toBe(false);
  });
});
