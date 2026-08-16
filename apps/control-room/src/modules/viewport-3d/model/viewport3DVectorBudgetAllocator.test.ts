import { describe, expect, it } from "vitest";

import type { Viewport3DFieldRenderOptions } from "../viewport3dRenderModel";

import {
  applyViewport3DGlobalVectorAllocationsToFieldRenderOptions,
  resolveViewport3DGlobalVectorAllocation,
} from "./viewport3DVectorBudgetAllocator";

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

  it("applies FEM allocations to both legacy budgets and target render plans", () => {
    const options = {
      partVectorBudgets: new Map([
        ["part-a", 64],
        ["part-b", 32],
      ]),
      targetRenderPlans: new Map([
        [
          "part-a",
          {
            targetId: "part-a",
            vectors: { budget: 64, visible: true },
          },
        ],
        [
          "part-b",
          {
            targetId: "part-b",
            vectors: { budget: 32, visible: true },
          },
        ],
      ]),
    } as unknown as Viewport3DFieldRenderOptions;

    const allocation = new Map([
      [
        "fem-part:part-a",
        {
          available: 64,
          effective: 3,
          reason: "global-cap" as const,
          requested: 64,
          targetId: "fem-part:part-a",
        },
      ],
      [
        "fem-part:part-b",
        {
          available: 32,
          effective: 0,
          reason: "global-cap" as const,
          requested: 32,
          targetId: "fem-part:part-b",
        },
      ],
    ]);

    const resolved = applyViewport3DGlobalVectorAllocationsToFieldRenderOptions(
      options,
      allocation,
    );

    expect(resolved.partVectorBudgets).toEqual(
      new Map([
        ["part-a", 3],
        ["part-b", 0],
      ]),
    );
    expect(resolved.targetRenderPlans?.get("part-a")?.vectors.budget).toBe(3);
    expect(resolved.targetRenderPlans?.get("part-b")?.vectors.budget).toBe(0);
    expect(options.partVectorBudgets).toEqual(
      new Map([
        ["part-a", 64],
        ["part-b", 32],
      ]),
    );
  });
});
