import { describe, expect, it } from "vitest";

import {
  buildViewport3DColorbarGroupKey,
  planViewport3DColorbars,
  type Viewport3DColorbarPlan,
} from "./viewport3DColorbarPlan";
import {
  buildViewport3DTargetRenderPlan,
  type Viewport3DTargetRenderPlan,
} from "./viewport3DFieldDataPlan";

function objectPlan(
  targetId: string,
  overrides: Partial<{
    palette: string;
    quantityId: string;
    surfaceColorSource: "component_x" | "component_y" | "component_z" | "magnitude" | "orientation";
    viewportColorbarVisible: boolean;
  }> = {},
): Viewport3DTargetRenderPlan {
  return buildViewport3DTargetRenderPlan({
    quantityId: overrides.quantityId ?? "m",
    settings: {
      geometryScope: "full",
      scalarColorPalette: overrides.palette ?? "viridis",
      shaderMonoColor: "#ffffff",
      shaderVisible: true,
      surfaceColorSource: overrides.surfaceColorSource ?? "component_x",
      vectorBudget: 0,
      vectorCenteringEnabled: true,
      vectorColorMode: "magnitude",
      vectorLengthScale: 1,
      vectorSurfaceOffsetEnabled: false,
      vectorSurfaceOffsetScale: 0,
      vectorsVisible: false,
      viewportColorbarVisible: overrides.viewportColorbarVisible ?? true,
      visible: true,
    },
    targetId,
    targetKind: "object",
  });
}

describe("viewport3DColorbarPlan", () => {
  it("keeps a requested viewport colorbar planned when range is unavailable", () => {
    const plans = planViewport3DColorbars({
      targets: [objectPlan("object:film")],
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      colorMode: "x",
      quantityId: "m",
      range: null,
      rangeState: "unavailable",
      targetIds: ["object:film"],
    });
  });

  it("keeps render identity stable across range-only updates", () => {
    const target = objectPlan("object:film");
    const groupKey = buildViewport3DColorbarGroupKey({
      colorMode: "x",
      palette: "viridis",
      quantityId: "m",
      scopeId: "object:film",
      scopeKind: "object",
    });
    const first = planViewport3DColorbars({
      rangeStatesByGroupKey: new Map([
        [groupKey, { range: { max: 1, min: -1 }, state: "current" }],
      ]),
      targets: [target],
    });
    const second = planViewport3DColorbars({
      rangeStatesByGroupKey: new Map([
        [groupKey, { range: { max: 2, min: -2 }, state: "current" }],
      ]),
      targets: [target],
    });

    expect(first[0]?.renderKey).toBe(second[0]?.renderKey);
    expect(first[0]?.range).toEqual({ max: 1, min: -1 });
    expect(second[0]?.range).toEqual({ max: 2, min: -2 });
  });

  it("retains a previous compatible range while the fresh range is pending", () => {
    const target = objectPlan("object:film");
    const groupKey = buildViewport3DColorbarGroupKey({
      colorMode: "x",
      palette: "viridis",
      quantityId: "m",
      scopeId: "object:film",
      scopeKind: "object",
    });
    const previous = new Map<string, Viewport3DColorbarPlan>([
      [
        groupKey,
        {
          colorMode: "x",
          groupKey,
          legendId: `viewport-3d-colorbar:${groupKey}`,
          palette: "viridis",
          quantityId: "m",
          range: { max: 1, min: -1 },
          rangeState: "current",
          renderKey: `viewport-3d-colorbar:${groupKey}`,
          scopeId: "object:film",
          scopeKind: "object",
          targetIds: ["object:film"],
        },
      ],
    ]);

    const plans = planViewport3DColorbars({
      previousPlans: previous,
      targets: [target],
    });

    expect(plans[0]?.rangeState).toBe("stale-compatible");
    expect(plans[0]?.range).toEqual({ max: 1, min: -1 });
  });

  it("splits plans when targets use different palettes or modes", () => {
    const plans = planViewport3DColorbars({
      targets: [
        objectPlan("object:film", { palette: "viridis" }),
        objectPlan("object:ring", {
          palette: "magma",
          surfaceColorSource: "component_y",
        }),
      ],
    });

    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => [plan.colorMode, plan.palette]).sort()).toEqual([
      ["x", "viridis"],
      ["y", "magma"],
    ]);
  });

  it("does not plan viewport colorbars for orientation or disabled viewport legends", () => {
    expect(
      planViewport3DColorbars({
        targets: [
          objectPlan("object:orientation", {
            surfaceColorSource: "orientation",
          }),
          objectPlan("object:hidden", {
            viewportColorbarVisible: false,
          }),
        ],
      }),
    ).toEqual([]);
  });
});
