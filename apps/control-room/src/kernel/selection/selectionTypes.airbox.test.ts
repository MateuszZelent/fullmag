import { describe, expect, it } from "vitest";

import { selectionRefEquals, type SelectionRef } from "./selectionTypes";

function airboxRef(
  overrides: Partial<Extract<SelectionRef, { type: "airbox" }>> = {},
): Extract<SelectionRef, { type: "airbox" }> {
  return {
    availability: "available",
    contractGap: null,
    executionState: "not_started",
    kind: "airbox.mesh",
    nodeId: "model:airbox:mesh",
    resourceState: "ready",
    type: "airbox",
    visualizationTargetId: "airbox",
    ...overrides,
  };
}

describe("Airbox selection status facets", () => {
  it("refreshes resource-derived status without changing Airbox selection identity", () => {
    const current = airboxRef();
    expect(selectionRefEquals(current, airboxRef())).toBe(true);

    for (const change of [
      { availability: "partial" as const },
      { contractGap: "Membership is loading." },
      { executionState: "running" as const },
      { resourceState: "loading" as const },
      { resourceState: "stale" as const },
    ]) {
      expect(selectionRefEquals(current, airboxRef(change))).toBe(false);
    }
  });
});
