import { describe, expect, it } from "vitest";

import { resolveViewport3DGlobalVectorAllocation } from "./viewport3DVectorBudgetAllocator";

describe("resolveViewport3DGlobalVectorAllocation", () => {
  it("caps the aggregate allocation while retaining every target deterministically", () => {
    const allocation = resolveViewport3DGlobalVectorAllocation(
      [
        { available: 10, requested: 10, targetId: "airbox" },
        { available: 10, requested: 10, targetId: "object-a" },
        { available: 10, requested: 10, targetId: "object-b" },
      ],
      5,
    );

    expect([...allocation.values()].reduce((sum, item) => sum + item.effective, 0)).toBe(5);
    expect([...allocation.keys()]).toEqual(["airbox", "object-a", "object-b"]);
    expect([...allocation.values()].every((item) => item.reason === "global-cap")).toBe(true);
  });

  it("clamps a target to its carrier capacity before applying the global cap", () => {
    const allocation = resolveViewport3DGlobalVectorAllocation(
      [{ available: 2, requested: 20, targetId: "airbox" }],
      20,
    );

    expect(allocation.get("airbox")).toEqual({
      available: 2,
      effective: 2,
      reason: "target-cap",
      requested: 2,
      targetId: "airbox",
    });
  });
});
