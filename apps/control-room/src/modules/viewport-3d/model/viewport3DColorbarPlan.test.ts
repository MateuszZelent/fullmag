import { describe, expect, it } from "vitest";

import {
  buildViewport3DColorbarGroupKey,
  planViewport3DColorbars,
  resolveViewport3DColorbarRangeStates,
  scalarColorBufferMatchesColorbarRequest,
  type Viewport3DColorbarPlan,
} from "./viewport3DColorbarPlan";
import {
  DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
  buildViewport3DTargetRenderPlan,
  type Viewport3DTargetRenderPlan,
} from "./viewport3DFieldDataPlan";

function objectPlan(
  targetId: string,
  overrides: Partial<{
    palette: string;
    projectionMode: "raw_nodal" | "surface_faces" | "thickness_average_z";
    quantityId: string;
    shaderVisible: boolean;
    surfaceColorSource: "component_x" | "component_y" | "component_z" | "magnitude" | "orientation";
    vectorColorMode: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
    vectorsVisible: boolean;
    viewportColorbarVisible: boolean;
  }> = {},
): Viewport3DTargetRenderPlan {
  return buildViewport3DTargetRenderPlan({
    quantityId: overrides.quantityId ?? "m",
    settings: {
      geometryScope: "full",
      scalarColorPalette: overrides.palette ?? "viridis",
      shaderMonoColor: "#ffffff",
      shaderVisible: overrides.shaderVisible ?? true,
      surfaceColorSource: overrides.surfaceColorSource ?? "component_x",
      surfaceProjectionMode: overrides.projectionMode ?? "raw_nodal",
      vectorBudget: 0,
      vectorCenteringEnabled: true,
      vectorColorMode: overrides.vectorColorMode ?? "magnitude",
      vectorLengthScale: 1,
      vectorSurfaceOffsetEnabled: false,
      vectorSurfaceOffsetScale: 0,
      vectorsVisible: overrides.vectorsVisible ?? false,
      viewportColorbarVisible: overrides.viewportColorbarVisible ?? true,
      visible: true,
    },
    targetId,
    targetKind: "object",
  });
}

function airboxPlan(
  targetId: string,
  overrides: Partial<{
    palette: string;
    quantityId: string;
    shaderVisible: boolean;
    surfaceColorSource: "component_x" | "component_y" | "component_z" | "magnitude" | "orientation";
    vectorColorMode: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
    vectorsVisible: boolean;
    viewportColorbarVisible: boolean;
  }> = {},
): Viewport3DTargetRenderPlan {
  return {
    ...objectPlan(targetId, overrides),
    targetKind: "airbox",
  };
}

describe("viewport3DColorbarPlan", () => {
  it("accepts an analysis mode scalar buffer for an m colorbar request", () => {
    expect(
      scalarColorBufferMatchesColorbarRequest({
        buffer: {
          colors: new Float32Array(3),
          colorMode: "magnitude",
          colorPalette: "coolwarm",
          quantityId: "analysis:eigen:sample-0000:mode-0000",
          range: { max: 1, min: -1 },
        },
        colorMode: "magnitude",
        colorPalette: "coolwarm",
        quantityId: "m",
      }),
    ).toBe(true);
  });

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

  it("plans a rendered range for Inspector even when the viewport colorbar is hidden", () => {
    const target = objectPlan("object:film", {
      viewportColorbarVisible: false,
    });

    expect(planViewport3DColorbars({ targets: [target] })).toEqual([]);
    expect(
      planViewport3DColorbars({
        includeInspectorRanges: true,
        targets: [target],
      }),
    ).toMatchObject([
      {
        colorMode: "x",
        quantityId: "m",
        scopeId: "object:film",
        scopeKind: "object",
      },
    ]);
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

  it("keeps render identity stable when the same target switches scalar component", () => {
    const [xPlan] = planViewport3DColorbars({
      targets: [objectPlan("object:film", { surfaceColorSource: "component_x" })],
    });
    const [yPlan] = planViewport3DColorbars({
      targets: [objectPlan("object:film", { surfaceColorSource: "component_y" })],
    });

    expect(xPlan?.groupKey).not.toBe(yPlan?.groupKey);
    expect(xPlan?.renderKey).toBe(yPlan?.renderKey);
  });

  it("splits colorbar groups by surface projection mode and range source", () => {
    const [rawPlan] = planViewport3DColorbars({
      targets: [objectPlan("object:film", { projectionMode: "raw_nodal" })],
    });
    const [facePlan] = planViewport3DColorbars({
      targets: [objectPlan("object:film", { projectionMode: "surface_faces" })],
    });

    expect(rawPlan?.groupKey).not.toBe(facePlan?.groupKey);
    expect(rawPlan).toMatchObject({
      projectionMode: "raw_nodal",
      rangeSource: "raw_nodal",
    });
    expect(facePlan).toMatchObject({
      projectionMode: "surface_faces",
      rangeSource: "face_values",
    });
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
          projectionMode: "raw_nodal",
          quantityId: "m",
          range: { max: 1, min: -1 },
          rangeSource: "raw_nodal",
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

  it("resolves planned range states from target pass scalar buffers", () => {
    const target = objectPlan("part:film");
    const [plan] = planViewport3DColorbars({ targets: [target] });

    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map(),
        targetPasses: new Map([
          [
            "part:film",
            {
              fieldBuffer: null,
              fieldBufferState: "derived-global",
              surface: {
                degradation: null,
                passId: "part:film:surface",
                scalarColorMode: "x",
                scalarColors: {
                  colors: new Float32Array(12),
                  colorMode: "x",
                  colorPalette: "viridis",
                  quantityId: "m",
                  range: { max: 1, min: -1 },
                  targetRevision: "field=1",
                  topologyRevision: "mesh=1",
                },
              },
              vectors: {
                buildReference: null,
                degradation: null,
                passId: "part:film:vector-glyph",
                segments: null,
              },
            },
          ],
        ]),
      },
      plans: plan ? [plan] : [],
    });

    expect(rangeStates.get(plan!.groupKey)).toEqual({
      range: { max: 1, min: -1 },
      state: "current",
    });
  });

  it("resolves a vector-only airbox colorbar range from scoped scalar colors", () => {
    const target = airboxPlan("airbox", {
      shaderVisible: false,
      surfaceColorSource: "orientation",
      vectorColorMode: "x",
      vectorsVisible: true,
      viewportColorbarVisible: true,
    });
    const [plan] = planViewport3DColorbars({ targets: [target] });
    const scalarColors = {
      colors: new Float32Array(12),
      colorMode: "x",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 2, min: -2 },
      targetRevision: "field=2",
      topologyRevision: "mesh=1",
    };

    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map([
          ["airbox", new Map([["x", scalarColors]])],
        ]),
        targetPasses: new Map([
          [
            "airbox",
            {
              surface: {
                scalarColorMode: null,
                scalarColors: null,
              },
            },
          ],
        ]),
      },
      plans: plan ? [plan] : [],
    });

    expect(rangeStates.get(plan!.groupKey)).toEqual({
      range: { max: 2, min: -2 },
      state: "current",
    });
  });

  it("resolves an FDM vector-only colorbar range from the vector scalar buffer", () => {
    const target = {
      ...objectPlan("fdm", {
        shaderVisible: false,
        surfaceColorSource: "orientation",
        vectorColorMode: "magnitude",
        vectorsVisible: true,
      }),
      targetKind: "fdm-domain" as const,
    };
    const [plan] = planViewport3DColorbars({ targets: [target] });
    const vectorColors = {
      colors: new Float32Array(12),
      colorMode: "magnitude",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 3, min: 0 },
    };

    const rangeStates = resolveViewport3DColorbarRangeStates({
      fdmVectorColors: vectorColors,
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map(),
        targetPasses: new Map(),
      },
      plans: plan ? [plan] : [],
    });

    expect(rangeStates.get(plan!.groupKey)).toEqual({
      range: { max: 3, min: 0 },
      state: "current",
    });
  });

  it("resolves independent FDM target ranges from target color buffers", () => {
    const plans = planViewport3DColorbars({
      targets: [objectPlan("object:left"), objectPlan("region:right:core")],
    });
    const targetBuffer = (min: number, max: number) => ({
      colors: new Float32Array(12),
      colorMode: "x",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max, min },
    });

    const rangeStates = resolveViewport3DColorbarRangeStates({
      fdmTargetColorBuffers: new Map([
        ["object:left", targetBuffer(-1, 0)],
        ["region:right:core", targetBuffer(2, 3)],
      ]),
      plans,
    });

    const leftPlan = plans.find((plan) => plan.targetIds.includes("object:left"));
    const rightPlan = plans.find((plan) =>
      plan.targetIds.includes("region:right:core"),
    );
    expect(rangeStates.get(leftPlan!.groupKey)).toEqual({
      range: { max: 0, min: -1 },
      state: "current",
    });
    expect(rangeStates.get(rightPlan!.groupKey)).toEqual({
      range: { max: 3, min: 2 },
      state: "current",
    });
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

  it("splits plans when targets use different scalar range policies", () => {
    const autoRangeTarget = {
      ...objectPlan("fdm-auto"),
      targetKind: "fdm-domain" as const,
    };
    const manualRangeTarget = {
      ...objectPlan("fdm-manual"),
      shader: {
        ...objectPlan("fdm-manual").shader,
        scalarRangePolicy: {
          ...DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
          max: 0.25,
          min: -0.25,
          mode: "manual" as const,
          symmetric: true,
        },
      },
      targetKind: "fdm-domain" as const,
    };

    const plans = planViewport3DColorbars({
      targets: [autoRangeTarget, manualRangeTarget],
    });

    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.targetIds)).toEqual([
      ["fdm-auto"],
      ["fdm-manual"],
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

  it("plans a numeric vector colorbar for vector-only airbox targets", () => {
    expect(
      planViewport3DColorbars({
        targets: [
          objectPlan("part:permalloy", {
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          airboxPlan("air:permalloy-geometry", {
            shaderVisible: false,
            surfaceColorSource: "orientation",
            vectorColorMode: "x",
            vectorsVisible: true,
            viewportColorbarVisible: true,
          }),
        ],
      }),
    ).toMatchObject([
      {
        colorMode: "x",
        scopeKind: "airbox",
        targetIds: ["air:permalloy-geometry"],
      },
      {
        scopeKind: "object",
        targetIds: ["part:permalloy"],
      },
    ]);
  });
});
