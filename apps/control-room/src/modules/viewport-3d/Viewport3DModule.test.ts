import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildViewport3DColorbarTargetPlans,
  formatHysteresisReplayGlyphVector,
  formatHysteresisReplayLabel,
  notifyMeshTopologyRendered,
  resolveViewport3DColorbarLegendsFromPlans,
  resolveViewport3DColorbarPlansForRender,
  resolveViewport3DColorbarRangeStates,
  resolveViewport3DRequestedColorbarGroupKeys,
  resolveRetainedViewport3DColorbarPlansForStore,
  resolveRetainedViewport3DScalarColorbarLegends,
  resolveViewport3DColorbarLegend,
  resolveViewport3DMeshQualityLegend,
  createViewport3DPointerHoldLifecycle,
  resolveViewport3DScalarColorbarLegend,
  resolveViewport3DScalarColorbarLegends,
  shouldClearRetainedViewport3DScalarColorbarLegends,
  shouldRetainViewport3DScalarColorbarLegends,
} from "./Viewport3DModule";
import { planViewport3DColorbars } from "./model/viewport3DColorbarPlan";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { ScalarColorBuffer } from "./viewport3dFieldMapping";

function scalarColorBuffer(
  mode: string,
  range: { max: number; min: number },
  colorPalette = "viridis",
  quantityId = "m",
): ScalarColorBuffer {
  return {
    colors: new Float32Array([0, 0, 0]),
    colorMode: mode,
    colorPalette,
    quantityId,
    range,
  };
}

function scalarColorbarPart(
  id: string,
  patch: {
    activeQuantityId?: string;
    label?: string;
    palette?: string;
    paletteInherited?: boolean;
    projectionMode?: "raw_nodal" | "surface_faces" | "thickness_average_z";
    source?: "component_x" | "component_y" | "component_z" | "magnitude";
    visible?: boolean;
  } = {},
) {
  return {
    id,
    label: patch.label ?? id,
    settings: {
      activeQuantityId: patch.activeQuantityId ?? "m",
      scalarColorPalette: patch.paletteInherited
        ? undefined
        : (patch.palette ?? "viridis"),
      shaderVisible: true,
      surfaceColorSource: patch.source ?? "component_x",
      surfaceProjectionMode: patch.projectionMode ?? "raw_nodal",
      viewportColorbarVisible: patch.visible ?? false,
      visible: true,
    },
  };
}

function visualizationSettings(
  patch: Partial<VisualizationTargetSettings> = {},
): VisualizationTargetSettings {
  return {
    activeQuantityId: patch.activeQuantityId ?? "m",
    airboxSyntheticVectorsEnabled: patch.airboxSyntheticVectorsEnabled ?? false,
    boundsVisible: patch.boundsVisible ?? true,
    geometryScope: patch.geometryScope ?? "full",
    opacityPercent: patch.opacityPercent ?? 100,
    pointColor: patch.pointColor ?? "#ffffff",
    pointsVisible: patch.pointsVisible ?? false,
    primitiveVisible: patch.primitiveVisible,
    renderMode: patch.renderMode ?? "surface",
    scalarColorPalette: patch.scalarColorPalette ?? "viridis",
    shaderColorMode: patch.shaderColorMode ?? "orientation",
    shaderMonoColor: patch.shaderMonoColor ?? "#ffffff",
    shaderVisible: patch.shaderVisible ?? true,
    surfaceColorSource: patch.surfaceColorSource ?? "component_x",
    surfaceProjectionMode: patch.surfaceProjectionMode ?? "raw_nodal",
    vectorAlphaPercent: patch.vectorAlphaPercent ?? 100,
    vectorBudget: patch.vectorBudget ?? 0,
    vectorCenteringEnabled: patch.vectorCenteringEnabled ?? true,
    vectorColorMode: patch.vectorColorMode ?? "magnitude",
    vectorLengthScale: patch.vectorLengthScale ?? 1,
    vectorMonoColor: patch.vectorMonoColor ?? "#ffffff",
    vectorSurfaceOffsetEnabled: patch.vectorSurfaceOffsetEnabled ?? false,
    vectorSurfaceOffsetScale: patch.vectorSurfaceOffsetScale ?? 0,
    vectorThickness: patch.vectorThickness ?? 1,
    vectorsVisible: patch.vectorsVisible ?? false,
    viewportColorbarVisible: patch.viewportColorbarVisible ?? true,
    visible: patch.visible ?? true,
    wireframeColor: patch.wireframeColor ?? "#ffffff",
    wireframeOpacityPercent: patch.wireframeOpacityPercent ?? 100,
    wireframeVisible: patch.wireframeVisible ?? false,
  };
}

describe("resolveViewport3DMeshQualityLegend", () => {
  it("preserves mesh-part boundary face identity in viewport selection refs", () => {
    const source = readFileSync(
      "src/modules/viewport-3d/Viewport3DModule.tsx",
      "utf8",
    );

    expect(source).toContain('type: "mesh-part"');
    expect(source).toContain("boundaryFaceIndex: partSelection.boundaryFaceIndex");
  });

  it("describes the active mesh quality metric and range", () => {
    expect(
      resolveViewport3DMeshQualityLegend(true, "sicn", {
        max: 0.92,
        min: 0.17,
      }),
    ).toBe("Mesh quality SICN 0.17 to 0.92");
  });

  it("stays hidden when the overlay is inactive or the range is missing", () => {
    expect(resolveViewport3DMeshQualityLegend(false, "gamma", { max: 1, min: 0 }))
      .toBeNull();
    expect(resolveViewport3DMeshQualityLegend(true, "gamma", null)).toBeNull();
  });
});

describe("createViewport3DPointerHoldLifecycle", () => {
  function createPointerEventTarget() {
    const listeners = new Map<string, EventListener>();
    return {
      addEventListener: vi.fn(
        (type: string, listener: EventListener) => listeners.set(type, listener),
      ),
      dispatch(type: "pointercancel" | "pointerup", pointerId: number) {
        listeners.get(type)?.({ pointerId } as PointerEvent);
      },
      removeEventListener: vi.fn(
        (type: string, listener: EventListener) => {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
      ),
    };
  }

  it("removes both terminal listeners when pointerup ends the hold", () => {
    const target = createPointerEventTarget();
    const onBegin = vi.fn();
    const onEnd = vi.fn();
    const hold = createViewport3DPointerHoldLifecycle({
      onBegin,
      onEnd,
      target,
    });

    hold.begin(1);
    target.dispatch("pointerup", 1);
    hold.dispose();

    expect(onBegin).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "pointerup",
      expect.any(Function),
      true,
    );
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "pointercancel",
      expect.any(Function),
      true,
    );
  });

  it("removes both terminal listeners when pointercancel ends the hold", () => {
    const target = createPointerEventTarget();
    const onEnd = vi.fn();
    const hold = createViewport3DPointerHoldLifecycle({
      onBegin: vi.fn(),
      onEnd,
      target,
    });

    hold.begin(1);
    target.dispatch("pointercancel", 1);
    hold.dispose();

    expect(onEnd).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("removes both terminal listeners and ends an active hold on unmount", () => {
    const target = createPointerEventTarget();
    const onEnd = vi.fn();
    const hold = createViewport3DPointerHoldLifecycle({
      onBegin: vi.fn(),
      onEnd,
      target,
    });

    hold.begin(1);
    hold.begin(1);
    hold.dispose();

    expect(onEnd).toHaveBeenCalledOnce();
    expect(target.addEventListener).toHaveBeenCalledTimes(2);
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("keeps the hold until the last active pointer ends", () => {
    const target = createPointerEventTarget();
    const onBegin = vi.fn();
    const onEnd = vi.fn();
    const hold = createViewport3DPointerHoldLifecycle({
      onBegin,
      onEnd,
      target,
    });

    hold.begin(11);
    hold.begin(22);
    target.dispatch("pointerup", 11);

    expect(onBegin).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();
    expect(target.removeEventListener).not.toHaveBeenCalled();

    target.dispatch("pointercancel", 22);

    expect(onEnd).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
  });
});

describe("resolveViewport3DColorbarLegend", () => {
  it("describes numeric component coloring with quantity, component, unit, and range", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "x",
        quantityId: "m",
        range: { max: 0.75, min: -0.25 },
        unit: "1",
      }),
    ).toMatchObject({
      label: "m x [1]",
      maxLabel: "0.75",
      minLabel: "-0.25",
      paletteGradient:
        "linear-gradient(90deg, rgb(68, 1, 84), rgb(49, 104, 142), rgb(53, 183, 121), rgb(253, 231, 37))",
    });
  });

  it("describes material scalar coloring without a vector component suffix", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "magnitude",
        colorPalette: "inferno",
        quantityId: "mat_ms",
        range: { max: 800e3, min: 400e3 },
        unit: "A/m",
      }),
    ).toMatchObject({
      label: "mat_ms [A/m]",
      paletteGradient:
        "linear-gradient(90deg, rgb(0, 0, 4), rgb(66, 10, 104), rgb(147, 43, 93), rgb(221, 81, 58), rgb(252, 255, 164))",
      maxLabel: "800000 A/m",
      minLabel: "400000 A/m",
    });
  });

  it("keeps physical units on field component colorbar limits", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "x",
        quantityId: "H_demag",
        range: { max: 1200, min: -350 },
        unit: "A/m",
      }),
    ).toMatchObject({
      label: "H_demag x [A/m]",
      maxLabel: "1200 A/m",
      minLabel: "-350 A/m",
    });
  });

  it("converts viewport colorbar limits to the selected display unit", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "x",
        displayUnit: "mT",
        quantityId: "H_demag",
        range: { max: 1_000_000, min: -500_000 },
        unit: "A/m",
      }),
    ).toMatchObject({
      label: "H_demag x [mT]",
      maxLabel: "1257 mT",
      minLabel: "-628.3 mT",
    });
  });

  it("stays hidden for orientation and HSL sphere coloring", () => {
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "orientation",
        quantityId: "m",
        range: { max: 1, min: 0 },
        unit: "1",
      }),
    ).toBeNull();
    expect(
      resolveViewport3DColorbarLegend({
        colorMode: "hsl_sphere",
        quantityId: "m",
        range: { max: 1, min: 0 },
        unit: "1",
      }),
    ).toBeNull();
  });

  it("uses the single rendered per-part scalar buffer for the viewport colorbar", () => {
    const xBuffer = scalarColorBuffer("x", { max: 0.4, min: -0.6 }, "inferno");

    expect(
      resolveViewport3DScalarColorbarLegend({
        colorPalette: "viridis",
        fieldModel: {
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map([
            ["part-a", new Map([["x", xBuffer]])],
          ]),
        },
        quantityId: "m",
        surfaceColorMode: "x",
        unit: "1",
        vectorColorMode: "orientation",
      }),
    ).toMatchObject({
      label: "m x [1]",
      maxLabel: "0.4",
      minLabel: "-0.6",
      paletteGradient:
        "linear-gradient(90deg, rgb(0, 0, 4), rgb(66, 10, 104), rgb(147, 43, 93), rgb(221, 81, 58), rgb(252, 255, 164))",
    });
  });

  it("hides the viewport colorbar for mixed per-part scalar scales", () => {
    expect(
      resolveViewport3DScalarColorbarLegend({
        colorPalette: "viridis",
        fieldModel: {
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map([
            [
              "part-a",
              new Map([["x", scalarColorBuffer("x", { max: 1, min: -1 })]]),
            ],
            [
              "part-b",
              new Map([["y", scalarColorBuffer("y", { max: 1, min: -1 })]]),
            ],
          ]),
        },
        quantityId: "m",
        surfaceColorMode: "x",
        unit: "1",
        vectorColorMode: "orientation",
      }),
    ).toBeNull();
  });

  it("keeps viewport scalar colorbars opt-in by part", () => {
    const xBuffer = scalarColorBuffer("x", { max: 0.4, min: -0.6 });

    expect(
      resolveViewport3DScalarColorbarLegends({
        colorPalette: "viridis",
        fieldModel: {
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map([
            ["part-a", new Map([["x", xBuffer]])],
          ]),
        },
        parts: [scalarColorbarPart("part-a", { visible: false })],
        quantityId: "m",
        surfaceColorMode: "x",
        unit: "1",
        vectorColorMode: "orientation",
      }),
    ).toEqual([]);
  });

  it("returns separate viewport colorbars for mixed opt-in part scales", () => {
    expect(
      resolveViewport3DScalarColorbarLegends({
        colorPalette: "viridis",
        fieldModel: {
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map([
            [
              "part-a",
              new Map([["x", scalarColorBuffer("x", { max: 1, min: -1 })]]),
            ],
            [
              "part-b",
              new Map([
                ["y", scalarColorBuffer("y", { max: 4, min: -2 }, "inferno")],
              ]),
            ],
          ]),
        },
        parts: [
          scalarColorbarPart("part-a", {
            label: "Permalloy",
            source: "component_x",
            visible: true,
          }),
          scalarColorbarPart("part-b", {
            label: "CoFeB",
            palette: "inferno",
            source: "component_y",
            visible: true,
          }),
        ],
        quantityId: "m",
        surfaceColorMode: "x",
        unit: "1",
        vectorColorMode: "orientation",
      }).map(({ legend }) => ({
        label: legend.label,
        maxLabel: legend.maxLabel,
        minLabel: legend.minLabel,
      })),
    ).toEqual([
      { label: "Permalloy: m x [1]", maxLabel: "1", minLabel: "-1" },
      { label: "CoFeB: m y [1]", maxLabel: "4", minLabel: "-2" },
    ]);
  });

  it("does not use global scalar range for a target-pass colorbar while target colors are pending", () => {
    expect(
      resolveViewport3DScalarColorbarLegends({
        colorPalette: "viridis",
        fieldModel: {
          scalarColors: null,
          scalarColorsByMode: new Map([
            ["x", scalarColorBuffer("x", { max: 1, min: -1 })],
          ]),
          scalarColorsByPartAndMode: new Map(),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  degradation: "surface-colors-unavailable",
                  passId: "part-a:surface",
                  scalarColorMode: "x",
                  scalarColors: null,
                },
                vectors: {
                  buildReference: null,
                  degradation: null,
                  passId: "part-a:vector-glyph",
                  segments: null,
                },
              },
            ],
          ]),
        },
        parts: [
          scalarColorbarPart("part-a", {
            label: "Permalloy",
            source: "component_x",
            visible: true,
          }),
        ],
        quantityId: "m",
        surfaceColorMode: "x",
        unit: "1",
        vectorColorMode: "orientation",
      })[0]?.legend,
    ).toMatchObject({
      maxLabel: "pending",
      minLabel: "pending",
    });
  });

  it("keeps viewport colorbar keys stable when only the scalar range updates", () => {
    const first = resolveViewport3DScalarColorbarLegends({
      colorPalette: "viridis",
      fieldModel: {
        scalarColors: null,
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map([
          [
            "part-a",
            new Map([["x", scalarColorBuffer("x", { max: 1, min: -1 })]]),
          ],
        ]),
      },
      parts: [
        scalarColorbarPart("part-a", {
          label: "Permalloy",
          source: "component_x",
          visible: true,
        }),
      ],
      quantityId: "m",
      surfaceColorMode: "x",
      unit: "1",
      vectorColorMode: "orientation",
    });
    const updated = resolveViewport3DScalarColorbarLegends({
      colorPalette: "viridis",
      fieldModel: {
        scalarColors: null,
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map([
          [
            "part-a",
            new Map([["x", scalarColorBuffer("x", { max: 0.5, min: -0.25 })]]),
          ],
        ]),
      },
      parts: [
        scalarColorbarPart("part-a", {
          label: "Permalloy",
          source: "component_x",
          visible: true,
        }),
      ],
      quantityId: "m",
      surfaceColorMode: "x",
      unit: "1",
      vectorColorMode: "orientation",
    });

    expect(updated[0]?.key).toBe(first[0]?.key);
    expect(updated[0]?.legend).toMatchObject({
      maxLabel: "0.5",
      minLabel: "-0.25",
    });
  });

  it("keeps the last viewport colorbar visible while a replacement scale is building", () => {
    const previous = [
      {
        key: "part-a:m:x:viridis",
        legend: {
          label: "Permalloy: m x [1]",
          maxLabel: "1",
          minLabel: "-1",
          paletteGradient: "linear-gradient(90deg, black, white)",
        },
      },
    ];
    const current = [
      {
        key: "part-b:m:y:viridis",
        legend: {
          label: "CoFeB: m y [1]",
          maxLabel: "0.5",
          minLabel: "-0.5",
          paletteGradient: "linear-gradient(90deg, black, white)",
        },
      },
    ];

    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current: [],
        previous,
        requested: true,
      }),
    ).toBe(previous);
    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current: [],
        previous,
        requested: false,
      }),
    ).toEqual([]);
    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current,
        previous,
        requested: true,
        requestedGroupKeys: new Set([
          "part-a:m:x:viridis",
          "part-b:m:y:viridis",
        ]),
      }),
    ).toEqual([...previous, ...current]);
    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current,
        previous,
        requested: true,
        requestedGroupKeys: new Set(["part-b:m:y:viridis"]),
      }),
    ).toEqual(current);
    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current: [
          {
            key: "part-a:m:y:viridis",
            legend: {
              label: "Permalloy: m y [1]",
              maxLabel: "0.75",
              minLabel: "-0.75",
              paletteGradient: "linear-gradient(90deg, black, white)",
            },
          },
        ],
        previous,
        requested: true,
        requestedGroupKeys: new Set(["part-a:m:y:viridis"]),
      }),
    ).toEqual([
      {
        key: "part-a:m:y:viridis",
        legend: {
          label: "Permalloy: m y [1]",
          maxLabel: "0.75",
          minLabel: "-0.75",
          paletteGradient: "linear-gradient(90deg, black, white)",
        },
      },
    ]);
  });

  it("uses the inherited palette when retaining viewport colorbar groups", () => {
    expect(
      resolveViewport3DRequestedColorbarGroupKeys(
        [
          scalarColorbarPart("part-a", {
            paletteInherited: true,
            source: "component_x",
            visible: true,
          }),
        ],
        "inferno",
      ),
    ).toEqual(new Set(["part-a:m:x:inferno"]));
    expect(
      resolveViewport3DRequestedColorbarGroupKeys([], "viridis", {
        fdmColorbarRequested: true,
      }),
    ).toEqual(new Set(["fdm"]));
  });

  it("includes surface projection mode when retaining viewport colorbar groups", () => {
    expect(
      resolveViewport3DRequestedColorbarGroupKeys(
        [
          scalarColorbarPart("part-a", {
            projectionMode: "surface_faces",
            source: "component_x",
            visible: true,
          }),
        ],
        "viridis",
      ),
    ).toEqual(new Set(["part-a:m:x:viridis:projection=surface_faces"]));
  });

  it("does not clear retained viewport colorbars while the render surface is unavailable", () => {
    expect(
      shouldClearRetainedViewport3DScalarColorbarLegends({
        fdmColorbarRequested: false,
        renderSurfaceAvailable: false,
        viewportColorbarRequested: false,
      }),
    ).toBe(false);
    expect(
      shouldClearRetainedViewport3DScalarColorbarLegends({
        fdmColorbarRequested: false,
        renderSurfaceAvailable: true,
        viewportColorbarRequested: false,
      }),
    ).toBe(true);
    expect(
      shouldClearRetainedViewport3DScalarColorbarLegends({
        fdmColorbarRequested: false,
        renderSurfaceAvailable: true,
        viewportColorbarRequested: true,
      }),
    ).toBe(false);
    expect(
      shouldRetainViewport3DScalarColorbarLegends({
        fdmColorbarRequested: false,
        renderSurfaceAvailable: false,
        viewportColorbarRequested: false,
      }),
    ).toBe(true);
    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current: [],
        previous: [
          {
            key: "part-a:m:x:viridis",
            legend: {
              label: "Permalloy: m x [1]",
              maxLabel: "1",
              minLabel: "-1",
              paletteGradient: "linear-gradient(90deg, black, white)",
            },
          },
        ],
        requested: shouldRetainViewport3DScalarColorbarLegends({
          fdmColorbarRequested: false,
          renderSurfaceAvailable: false,
          viewportColorbarRequested: false,
        }),
      }),
    ).toHaveLength(1);
    expect(
      shouldRetainViewport3DScalarColorbarLegends({
        fdmColorbarRequested: false,
        renderSurfaceAvailable: true,
        viewportColorbarRequested: false,
      }),
    ).toBe(false);
  });

  it("keeps retained viewport colorbar plans during transient empty target refreshes", () => {
    const retainedPlan = planViewport3DColorbars({
      rangeStatesByGroupKey: new Map([
        [
          "m:x:viridis:part:part-a:range=auto=linear=asymmetric=min:auto=max:auto",
          {
            range: { max: 1, min: -1 },
            state: "current",
          },
        ],
      ]),
      targets: buildViewport3DColorbarTargetPlans({
        parts: [
          {
            id: "part-a",
            label: "Permalloy",
            settings: visualizationSettings({
              surfaceColorSource: "component_x",
              viewportColorbarVisible: true,
            }),
            targetKind: "part",
          },
        ],
      }),
    });

    expect(
      resolveViewport3DColorbarPlansForRender({
        planned: [],
        renderSurfaceAvailable: true,
        retained: retainedPlan,
        targetPlanAvailable: false,
        viewportColorbarRequested: false,
      }),
    ).toBe(retainedPlan);
    expect(
      resolveRetainedViewport3DColorbarPlansForStore({
        planned: [],
        renderSurfaceAvailable: true,
        retained: retainedPlan,
        targetPlanAvailable: false,
        viewportColorbarRequested: false,
      }),
    ).toBe(retainedPlan);
  });

  it("does not carry retained per-part colorbars into FDM colorbar mode", () => {
    const previous = [
      {
        key: "part-a:m:x:viridis",
        legend: {
          label: "Permalloy: m x [1]",
          maxLabel: "1",
          minLabel: "-1",
          paletteGradient: "linear-gradient(90deg, black, white)",
        },
      },
    ];
    const current = [
      {
        key: "fdm",
        legend: {
          label: "m x [1]",
          maxLabel: "0.5",
          minLabel: "-0.5",
          paletteGradient: "linear-gradient(90deg, black, white)",
        },
      },
    ];

    expect(
      resolveRetainedViewport3DScalarColorbarLegends({
        current,
        previous,
        requested: true,
        requestedGroupKeys: new Set(["fdm"]),
      }),
    ).toEqual(current);
  });

  it("plans viewport colorbars from target demand before scalar buffers are ready", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      parts: [
        {
          id: "part-a",
          label: "Permalloy",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
      ],
    });
    const requested = planViewport3DColorbars({ targets });
    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map(),
      },
      plans: requested,
    });
    const plans = planViewport3DColorbars({
      rangeStatesByGroupKey: rangeStates,
      targets,
    });
    const legends = resolveViewport3DColorbarLegendsFromPlans({
      labelByTargetId: new Map([["part-a", "Permalloy"]]),
      plans,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      range: null,
      rangeState: "pending",
      targetIds: ["part-a"],
    });
    expect(legends).toEqual([
      {
        key: plans[0]?.renderKey,
        legend: expect.objectContaining({
          label: "Permalloy: m x [1]",
          maxLabel: "pending",
          minLabel: "pending",
        }),
      },
    ]);
  });

  it("does not plan a second viewport colorbar for air-interface parts", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      parts: [
        {
          id: "part:permalloy_layer",
          label: "permalloy_layer",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
        {
          id: "part:air-permalloy-interface",
          label: "Air ↔ permalloy_layer_geom",
          role: "interface",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
      ],
    });

    const plans = planViewport3DColorbars({ targets });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      scopeKind: "part",
      targetIds: ["part:permalloy_layer"],
    });
  });

  it("updates viewport colorbar range without changing the render key", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      parts: [
        {
          id: "part-a",
          label: "Permalloy",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
      ],
    });
    const requested = planViewport3DColorbars({ targets });
    const firstRangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map([
          [
            "part-a",
            new Map([["x", scalarColorBuffer("x", { max: 1, min: -1 })]]),
          ],
        ]),
      },
      plans: requested,
    });
    const first = planViewport3DColorbars({
      rangeStatesByGroupKey: firstRangeStates,
      targets,
    });
    const secondRangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map([
          [
            "part-a",
            new Map([
              ["x", scalarColorBuffer("x", { max: 0.25, min: -0.75 })],
            ]),
          ],
        ]),
      },
      plans: requested,
    });
    const second = planViewport3DColorbars({
      previousPlans: new Map(first.map((plan) => [plan.groupKey, plan])),
      rangeStatesByGroupKey: secondRangeStates,
      targets,
    });

    expect(second[0]?.renderKey).toBe(first[0]?.renderKey);
    expect(second[0]?.range).toEqual({ max: 0.25, min: -0.75 });
    expect(second[0]?.rangeState).toBe("current");
  });

  it("uses target-pass scalar ranges for mixed target viewport colorbars", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      parts: [
        {
          id: "part-a",
          label: "Permalloy",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
        {
          id: "part-b",
          label: "CoFeB",
          settings: visualizationSettings({
            surfaceColorSource: "orientation",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
        {
          id: "part-c",
          label: "Vectors",
          settings: visualizationSettings({
            shaderVisible: false,
            surfaceColorSource: "solid",
            vectorBudget: 512,
            vectorsVisible: true,
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
      ],
    });
    const requested = planViewport3DColorbars({ targets });
    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map([
          ["x", scalarColorBuffer("x", { max: 1, min: -1 }, "viridis", "m")],
        ]),
        scalarColorsByPartAndMode: new Map(),
        targetPasses: new Map([
          [
            "part-a",
            {
              fieldBuffer: null,
              fieldBufferState: "target-buffer",
              surface: {
                passId: "test:surface",
degradation: null,
                scalarColorMode: "x",
                scalarColors: scalarColorBuffer(
                  "x",
                  { max: 0.25, min: -0.75 },
                  "viridis",
                  "m",
                ),
              },
              vectors: {
                passId: "test:vector-glyph",
buildReference: null,
                degradation: null,
                segments: null,
              },
            },
          ],
        ]),
      },
      plans: requested,
    });
    const plans = planViewport3DColorbars({
      rangeStatesByGroupKey: rangeStates,
      targets,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      colorMode: "x",
      range: { max: 0.25, min: -0.75 },
      rangeState: "current",
      targetIds: ["part-a"],
    });
  });

  it("does not use a global colorbar range when a target-pass surface rejects the mode", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      parts: [
        {
          id: "part-a",
          label: "Permalloy",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
      ],
    });
    const requested = planViewport3DColorbars({ targets });
    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map([
          ["x", scalarColorBuffer("x", { max: 1, min: -1 }, "viridis", "m")],
        ]),
        scalarColorsByPartAndMode: new Map(),
        targetPasses: new Map([
          [
            "part-a",
            {
              fieldBuffer: null,
              fieldBufferState: "target-buffer",
              surface: {
                passId: "test:surface",
degradation: "sampled-buffer-not-surface-capable",
                scalarColorMode: "x",
                scalarColors: null,
              },
              vectors: {
                passId: "test:vector-glyph",
buildReference: null,
                degradation: null,
                segments: null,
              },
            },
          ],
        ]),
      },
      plans: requested,
    });
    const plans = planViewport3DColorbars({
      rangeStatesByGroupKey: rangeStates,
      targets,
    });

    expect(plans[0]).toMatchObject({
      range: null,
      rangeState: "pending",
      targetIds: ["part-a"],
    });
  });

  it("uses the full-domain target-pass range before global colorbar buffers", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      fdmSettings: visualizationSettings({
        surfaceColorSource: "component_x",
        viewportColorbarVisible: true,
      }),
      parts: [],
    });
    const requested = planViewport3DColorbars({ targets });
    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map([
          ["x", scalarColorBuffer("x", { max: 1, min: -1 }, "viridis", "m")],
        ]),
        scalarColorsByPartAndMode: new Map(),
        targetPasses: new Map([
          [
            "full",
            {
              fieldBuffer: null,
              fieldBufferState: "derived-global",
              surface: {
                degradation: null,
                passId: "full:surface",
                scalarColorMode: "x",
                scalarColors: scalarColorBuffer(
                  "x",
                  { max: 0.25, min: -0.75 },
                  "viridis",
                  "m",
                ),
              },
              vectors: {
                buildReference: null,
                degradation: null,
                passId: "full:vector-glyph",
                segments: null,
              },
            },
          ],
        ]),
      },
      plans: requested,
    });
    const plans = planViewport3DColorbars({
      rangeStatesByGroupKey: rangeStates,
      targets,
    });

    expect(plans[0]).toMatchObject({
      range: { max: 0.25, min: -0.75 },
      rangeState: "current",
      scopeKind: "full",
      targetIds: ["fdm"],
    });
  });

  it("does not use global full-domain colorbar buffers when target-pass model is authoritative but missing the full target", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      fdmSettings: visualizationSettings({
        surfaceColorSource: "component_x",
        viewportColorbarVisible: true,
      }),
      parts: [],
    });
    const requested = planViewport3DColorbars({ targets });
    const rangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map([
          ["x", scalarColorBuffer("x", { max: 1, min: -1 }, "viridis", "m")],
        ]),
        scalarColorsByPartAndMode: new Map(),
        targetPasses: new Map([
          [
            "part-a",
            {
              fieldBuffer: null,
              fieldBufferState: "target-buffer",
              surface: {
                degradation: null,
                passId: "part-a:surface",
                scalarColorMode: "x",
                scalarColors: scalarColorBuffer(
                  "x",
                  { max: 0.25, min: -0.75 },
                  "viridis",
                  "m",
                ),
              },
              vectors: {
                buildReference: null,
                degradation: null,
                passId: "part-a:vector-glyph",
                segments: null,
              },
            },
          ],
        ]),
      },
      plans: requested,
    });
    const plans = planViewport3DColorbars({
      rangeStatesByGroupKey: rangeStates,
      targets,
    });

    expect(plans[0]).toMatchObject({
      range: null,
      rangeState: "pending",
      scopeKind: "full",
      targetIds: ["fdm"],
    });
  });

  it("retains the previous compatible colorbar range while the next range is pending", () => {
    const targets = buildViewport3DColorbarTargetPlans({
      parts: [
        {
          id: "part-a",
          label: "Permalloy",
          settings: visualizationSettings({
            surfaceColorSource: "component_x",
            viewportColorbarVisible: true,
          }),
          targetKind: "part",
        },
      ],
    });
    const requested = planViewport3DColorbars({ targets });
    const readyRangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map([
          [
            "part-a",
            new Map([["x", scalarColorBuffer("x", { max: 1, min: -1 })]]),
          ],
        ]),
      },
      plans: requested,
    });
    const ready = planViewport3DColorbars({
      rangeStatesByGroupKey: readyRangeStates,
      targets,
    });
    const pendingRangeStates = resolveViewport3DColorbarRangeStates({
      fieldModel: {
        scalarColorsByMode: new Map(),
        scalarColorsByPartAndMode: new Map(),
      },
      plans: requested,
    });
    const pending = planViewport3DColorbars({
      previousPlans: new Map(ready.map((plan) => [plan.groupKey, plan])),
      rangeStatesByGroupKey: pendingRangeStates,
      targets,
    });
    const legends = resolveViewport3DColorbarLegendsFromPlans({
      labelByTargetId: new Map([["part-a", "Permalloy"]]),
      plans: pending,
    });

    expect(pending[0]?.rangeState).toBe("stale-compatible");
    expect(pending[0]?.range).toEqual({ max: 1, min: -1 });
    expect(legends[0]?.legend).toMatchObject({
      maxLabel: "1",
      minLabel: "-1",
    });
  });
});

describe("formatHysteresisReplayLabel", () => {
  it("labels the loaded hysteresis point snapshot in the 3D HUD", () => {
    expect(
      formatHysteresisReplayLabel({
        fieldOrientation: "in_plane_y",
        fieldRevision: 41,
        measurementAxis: "field_axis",
        meshIdentity: "study_domain",
        pointId: 4,
        quantityId: "m",
        resourceRef: null,
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
      }),
    ).toBe("Replay Hysteresis point 4 · hysteresis_point_005");
    expect(formatHysteresisReplayLabel(null)).toBeNull();
  });
});

describe("formatHysteresisReplayGlyphVector", () => {
  it("serializes normalized replay glyph vectors for viewport frame diagnostics", () => {
    expect(formatHysteresisReplayGlyphVector([0, 0.6, 0.8])).toBe(
      "0.000000 0.600000 0.800000",
    );
    expect(formatHysteresisReplayGlyphVector(null)).toBe("");
  });
});

describe("notifyMeshTopologyRendered", () => {
  it("emits one topology-rendered event per mesh revision", () => {
    const emit = vi.fn();
    const lastRevision = { current: null as string | number | null };

    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision,
      meshRevision: 7,
      rendererId: "viewport-3d-main",
    });
    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision,
      meshRevision: 7,
      rendererId: "viewport-3d-main",
    });
    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision,
      meshRevision: "8",
      rendererId: "viewport-3d-main",
    });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, "mesh:topology-rendered", {
      meshRevision: 7,
      rendererId: "viewport-3d-main",
    });
    expect(emit).toHaveBeenNthCalledWith(2, "mesh:topology-rendered", {
      meshRevision: "8",
      rendererId: "viewport-3d-main",
    });
  });

  it("does not emit before a real topology revision is known", () => {
    const emit = vi.fn();

    notifyMeshTopologyRendered({
      bus: { emit },
      lastRevision: { current: null },
      meshRevision: null,
      rendererId: "viewport-3d-main",
    });

    expect(emit).not.toHaveBeenCalled();
  });
});

describe("Viewport3DModule scene wiring", () => {
  it("keeps ordinary camera gestures local while explicit camera patches persist", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );
    const patchCameraStart = source.indexOf("const patchCameraState = useCallback");
    const saveCameraStart = source.indexOf("const saveCameraState = useCallback");
    const renderStart = source.indexOf("\n  return (", saveCameraStart);

    expect(patchCameraStart).toBeGreaterThanOrEqual(0);
    expect(saveCameraStart).toBeGreaterThan(patchCameraStart);
    expect(renderStart).toBeGreaterThan(saveCameraStart);

    const patchCameraStateSource = source.slice(patchCameraStart, saveCameraStart);
    const saveCameraStateSource = source.slice(saveCameraStart, renderStart);

    expect(patchCameraStateSource).toContain(
      "kernel.cameraRegistry.patchCamera(patch);",
    );
    expect(patchCameraStateSource).not.toContain("visualizationSync.queuePatch");
    expect(saveCameraStateSource).toContain("viewport3dStore.setCamera(nextCamera);");
    expect(saveCameraStateSource).not.toContain("kernel.cameraRegistry.patchCamera");
    expect(saveCameraStateSource).toContain("orthographicScale");
    expect(saveCameraStateSource).not.toContain("visualizationSync.queuePatch");
    expect(saveCameraStateSource).not.toContain("queuePatch({ camera: nextCamera })");
    expect(source).toContain("kernel.cameraRegistry.beginInteraction();");
    expect(source).toContain("kernel.cameraRegistry.endInteraction();");
    expect(source).toContain(
      "onCameraInteractionStart={beginCameraInteraction}",
    );
    expect(source).toContain("onCameraInteractionEnd={endCameraInteraction}");
  });

  it("installs the Three console policy before mounting the R3F canvas", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );
    const installCall = source.indexOf("installViewport3DThreeConsolePolicy();");
    const canvasStart = source.indexOf("<Viewport3DCanvas");

    expect(source).toContain(
      'import { installViewport3DThreeConsolePolicy } from "./viewport3dThreeConsolePolicy";',
    );
    expect(installCall).toBeGreaterThanOrEqual(0);
    expect(canvasStart).toBeGreaterThan(installCall);
  });

  it("forwards dimension-frame widget state into the scene", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "dimensionFrameMode={commandState.widgets.dimensionFrameMode}",
    );
    expect(source).toContain(
      "dimensionFrameDensity={commandState.widgets.dimensionFrameDensity}",
    );
    expect(source).toContain(
      "scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}",
    );
    expect(source).toContain("scaleUnitMode={commandState.widgets.scaleUnitMode}");
  });

  it("does not remount the native canvas for visual-profile-only changes", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("canvasContextKey");
    expect(source).toContain("Viewport3DRendererProfile");
    expect(source).not.toContain("key={`viewport-3d-canvas-${visualProfile.id}`}");
    expect(source).not.toContain("${effectAntialias ? \"aa\" : \"no-aa\"}");
  });

  it("captures screenshots after a committed viewport frame instead of a fixed timeout", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("pendingCaptureRevisionRef");
    expect(source).toContain("completePendingViewport3DCapture");
    expect(source).not.toContain("window.setTimeout(captureFrame, 80)");
  });

  it("keeps canvas DPR fixed during camera gestures to avoid zoom flicker", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );
    const canvasStart = source.indexOf("<Viewport3DCanvas");
    const canvasBlock = source.slice(canvasStart, source.indexOf(">", canvasStart));

    expect(canvasBlock).toContain("dpr={canvasDpr}");
    expect(source).not.toContain('import { AdaptiveDpr } from "@react-three/drei";');
    expect(source).not.toContain("<AdaptiveDpr");
    expect(source).not.toContain("interactionActive: sceneProps.interactionActive");
  });

  it("keeps R3F Canvas configuration props referentially stable", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );
    const canvasStart = source.indexOf("<Viewport3DCanvas");
    const canvasBlock = source.slice(canvasStart, source.indexOf(">", canvasStart));

    expect(source).toContain("const canvasCamera = useMemo");
    expect(source).toContain('import { Viewport3DCanvas } from "./Viewport3DCanvas";');
    expect(source).not.toContain('import { Canvas, useThree } from "@react-three/fiber";');
    expect(source).toContain("VIEWPORT_3D_CANVAS_GL_NO_ANTIALIAS");
    expect(source).toContain("VIEWPORT_3D_CANVAS_GL_ANTIALIAS");
    expect(source).toContain("VIEWPORT_3D_CANVAS_GL_CAPTURE");
    expect(source).toContain("resolveStableViewport3DCanvasGlOptions");
    expect(source).toContain(
      "const canvasGlOptions = resolveStableViewport3DCanvasGlOptions(visualProfile);",
    );
    expect(source).toContain("const handleCanvasCreated = useCallback");
    expect(source).toContain("const handleCanvasContextMenu = useCallback");
    expect(source).toContain("const handleCanvasPointerMissed = useCallback");
    expect(canvasBlock).toContain("camera={canvasCamera}");
    expect(canvasBlock).toContain("gl={canvasGlOptions}");
    expect(canvasBlock).toContain("onCreated={handleCanvasCreated}");
    expect(canvasBlock).toContain("onContextMenu={handleCanvasContextMenu}");
    expect(canvasBlock).toContain("onPointerMissed={handleCanvasPointerMissed}");
    expect(canvasBlock).not.toContain("camera={{");
    expect(canvasBlock).not.toContain("onCreated={({ gl }) =>");
  });

  it("suppresses the native context menu because right button pans the camera", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const handleCanvasContextMenu = useCallback");
    expect(source).toContain("event.preventDefault();");
  });

  it("holds live field updates from pointer down until pointer release", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("onBegin: beginViewport3DFieldUpdateHold,");
    expect(source).toContain("onEnd: endViewport3DFieldUpdateHold,");
    expect(source).toContain("createViewport3DPointerHoldLifecycle");
    expect(source).not.toContain("scheduleFieldUpdatePointerHoldRelease");
    expect(source).not.toContain("fieldUpdatePointerHoldReleaseTimeoutRef");
    expect(source).not.toContain("}, 150);");
    expect(source).toContain("onPointerDownCapture={holdFieldUpdatesForPointerGesture}");
    expect(source).toContain("onPointerUpCapture={releaseFieldUpdatePointerHold}");
    expect(source).toContain("onPointerCancelCapture={releaseFieldUpdatePointerHold}");
  });

  it("exposes camera diagnostics for browser smoke checks", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'data-camera-position={sceneProps.cameraState.position.join(" ")}',
    );
    expect(source).toContain('data-camera-projection={sceneProps.cameraProjection}');
    expect(source).toContain(
      'data-camera-target={sceneProps.cameraState.target.join(" ")}',
    );
    expect(source).toContain(
      'data-camera-up={sceneProps.cameraState.up.join(" ")}',
    );
    expect(source).toContain(
      'data-hysteresis-replay-snapshot-id={hysteresisReplayTarget?.snapshotId ?? ""}',
    );
    expect(source).toContain(
      'data-hysteresis-replay-stage-id={hysteresisReplayTarget?.stageId ?? ""}',
    );
  });

  it("mounts an explicit field-data issue dialog for missing shader or vector data", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Viewport3DResourceIssueDialog");
    expect(source).toContain("fieldDataIssue");
    expect(source).toContain("Magnetic field data unavailable");
  });

  it("gates the temporary azimuth and polar controls behind an explicit browser debug flag", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("viewport3DOrbitDebugEnabledFromBrowserConfig()");
    expect(source).toContain("const orbitDebugEnabled =");
    expect(source).toContain("orbitDebugEnabled && clientReady && colors");
    expect(source).toContain(
      "onOrbitDebugAnglesChange={\n              orbitDebugEnabled ? syncOrbitDebugAngles : undefined\n            }",
    );
    expect(source).toContain("Viewport3DOrbitDebugPanel");
    expect(source).toContain('aria-label="Temporary orbit controls"');
    expect(source).toContain('label="Azimuth"');
    expect(source).toContain('label="Polar"');
    expect(source).toContain("orbitDebugRevision");
    expect(source).toContain("orbitDebugCommitRevision");
    expect(source).toContain("onAnglesCommit={commitOrbitDebugAngles}");
  });

  it("offers disabled, automatic, authored, realized, and combined region overlay modes", () => {
    const source = readFileSync(
      new URL("./Viewport3DModule.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('useState<RegionOverlayMode>("auto")');
    expect(source).toContain('aria-label="Region overlays"');
    expect(source).toContain("Off");
    expect(source).toContain("Auto");
    expect(source).toContain("Authored");
    expect(source).toContain("Realized");
    expect(source).toContain("Both");

    const styles = readFileSync(
      new URL("../../design/styles/viewport-3d.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.fm-viewport-3d__region-modes\s*\{[\s\S]*?pointer-events:\s*auto;/,
    );
  });
});
