import { describe, expect, it } from "vitest";

import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
  renderModePatch,
  resolveAirboxVisualizationSettingsFromState,
  resolveEffectiveVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
  visualizationStateOverrideFromTargetPatch,
  resolveVisualizationSettings,
  resolveVisualizationTargetFromSelection,
  visualizationStatePatchFromDefaultTargetPatch,
  visualizationTargetKey,
} from "./ObjectVisualizationController";

describe("ObjectVisualizationController", () => {
  it("keeps production style defaults for object and airbox targets", () => {
    expect(DEFAULT_OBJECT_VISUALIZATION).toMatchObject({
      geometryScope: "full",
      opacityPercent: 100,
      renderMode: "surface+edges",
      shaderColorMode: "orientation",
      shaderMonoColor: "var(--fm-surface-magnetic)",
      shaderVisible: true,
      surfaceColorSource: "orientation",
      vectorAlphaPercent: 100,
      vectorColorMode: "orientation",
      vectorMonoColor: "var(--fm-accent)",
      vectorThickness: 1,
      vectorsVisible: false,
      wireframeColor: "var(--fm-border-strong)",
      wireframeOpacityPercent: 100,
      wireframeVisible: true,
    });
    expect(DEFAULT_AIRBOX_VISUALIZATION).toMatchObject({
      geometryScope: "full",
      opacityPercent: 28,
      renderMode: "wireframe",
      shaderColorMode: "monochrome",
      shaderMonoColor: "var(--fm-airbox-fill)",
      shaderVisible: false,
      surfaceColorSource: "solid",
      vectorAlphaPercent: 100,
      vectorColorMode: "orientation",
      vectorMonoColor: "var(--fm-accent)",
      vectorThickness: 1,
      vectorsVisible: false,
      wireframeColor: "var(--fm-airbox-wire)",
      wireframeOpacityPercent: 100,
      wireframeVisible: true,
    });
  });

  it("patches and normalizes per-target shader wireframe and vector style fields", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "arch", kind: "object" as const };

    controller.patchTarget(target, {
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ff3366",
      vectorAlphaPercent: 144,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: -3,
      wireframeColor: "#111111",
      wireframeOpacityPercent: -20,
    });

    expect(controller.getSettings(target)).toMatchObject({
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ff3366",
      surfaceColorSource: "solid",
      vectorAlphaPercent: 100,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 0.1,
      wireframeColor: "#111111",
      wireframeOpacityPercent: 0,
    });
  });

  it("normalizes surface color source while preserving legacy color mode compatibility", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "arch", kind: "object" as const };

    controller.patchTarget(target, { surfaceColorSource: "component_x" });

    expect(controller.getSettings(target)).toMatchObject({
      shaderColorMode: "x",
      surfaceColorSource: "component_x",
    });

    controller.patchTarget(target, {
      shaderColorMode: "magnitude",
      surfaceColorSource: undefined,
    });

    expect(controller.getSettings(target)).toMatchObject({
      shaderColorMode: "magnitude",
      surfaceColorSource: "magnitude",
    });

    controller.patchTarget(target, {
      shaderColorMode: undefined,
      surfaceColorSource: undefined,
    });

    expect(controller.getSettings(target)).toMatchObject({
      shaderColorMode: "orientation",
      surfaceColorSource: "orientation",
    });
  });

  it("keeps local-only airbox style fields out of backend visualization patches", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        shaderColorMode: "monochrome",
        shaderMonoColor: "#ffffff",
        surfaceColorSource: "solid",
        vectorAlphaPercent: 44,
        vectorColorMode: "magnitude",
        vectorThickness: 2,
        wireframeColor: "#888888",
        wireframeOpacityPercent: 75,
      }),
    ).toEqual({});
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        shaderColorMode: "monochrome",
        shaderMonoColor: "#ffffff",
        surfaceColorSource: "solid",
        vectorAlphaPercent: 44,
        vectorColorMode: "magnitude",
        vectorThickness: 2,
        wireframeColor: "#888888",
        wireframeOpacityPercent: 75,
      }),
    ).toEqual({
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ffffff",
      surfaceColorSource: "solid",
      vectorAlphaPercent: 44,
      vectorColorMode: "magnitude",
      vectorThickness: 2,
      wireframeColor: "#888888",
      wireframeOpacityPercent: 75,
    });
  });

  it("resolves canonical target ids from object and airbox selections", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      }),
    ).toEqual({
      id: "free-layer",
      kind: "object",
      label: "Free layer",
    });

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.visualization",
        label: "Airbox Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
      }),
    ).toEqual(AIRBOX_VISUALIZATION_TARGET);
  });

  it("patches and clears target overrides without storing resource data", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    controller.patchTarget(target, {
      opacityPercent: 41,
      renderMode: "wireframe",
      vectorsVisible: true,
    });

    expect(controller.getSettings(target)).toMatchObject({
      opacityPercent: 41,
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: true,
    });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(target)])
      .toMatchObject({
        opacityPercent: 41,
        renderMode: "wireframe",
      });

    controller.clearTarget(target);

    expect(controller.getSettings(target)).toMatchObject({
      opacityPercent: 100,
      renderMode: "surface+edges",
    });
  });

  it("keeps the external-store snapshot reference stable between changes", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    const initial = controller.getSnapshot();

    expect(controller.getSnapshot()).toBe(initial);

    controller.patchTarget(target, {
      opacityPercent: 41,
      renderMode: "wireframe",
    });

    const patched = controller.getSnapshot();
    expect(patched).not.toBe(initial);
    expect(controller.getSnapshot()).toBe(patched);

    controller.patchTarget(target, {
      opacityPercent: 41,
      renderMode: "wireframe",
    });

    expect(controller.getSnapshot()).toBe(patched);

    controller.clearTarget(target);

    const cleared = controller.getSnapshot();
    expect(cleared).not.toBe(patched);
    expect(controller.getSnapshot()).toBe(cleared);
  });

  it("normalizes render-mode patches into primitive layer flags", () => {
    expect(renderModePatch("surface+edges")).toMatchObject({
      pointsVisible: false,
      shaderVisible: true,
      wireframeVisible: true,
    });
    expect(renderModePatch("points")).toMatchObject({
      pointsVisible: true,
      shaderVisible: false,
      wireframeVisible: false,
    });
  });

  it("merges per-target overrides over a caller-provided global base", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    controller.patchTarget(target, {
      opacityPercent: 35,
      wireframeVisible: true,
    });

    expect(
      resolveVisualizationSettings(controller.getSnapshot(), target, {
        ...DEFAULT_OBJECT_VISUALIZATION,
        boundsVisible: false,
        geometryScope: "full",
        opacityPercent: 80,
        pointsVisible: true,
        renderMode: "points",
        shaderVisible: false,
        vectorsVisible: true,
        visible: true,
        wireframeVisible: false,
      }),
    ).toMatchObject({
      opacityPercent: 35,
      boundsVisible: false,
      pointsVisible: true,
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: true,
    });
  });

  it("resolves object targets from canonical global vector state before local overrides", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    const visualizationState = {
      layers: {
        vectors: {
          density: 512,
          domain: "full_domain",
          visible: true,
        },
      },
      revision: 11,
      vector_glyphs: true,
    };

    expect(
      resolveGlobalObjectVisualizationSettings(visualizationState as never),
    ).toMatchObject({
      vectorsVisible: true,
    });

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: visualizationState as never,
      }),
    ).toMatchObject({
      effectiveSettings: {
        vectorsVisible: true,
      },
      override: null,
      revision: "0:11",
      settings: {
        vectorsVisible: true,
      },
    });

    controller.patchTarget(target, { vectorsVisible: false });

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: visualizationState as never,
      }),
    ).toMatchObject({
      effectiveSettings: {
        vectorsVisible: false,
      },
      override: {
        vectorsVisible: false,
      },
      revision: "1:11",
      settings: {
        vectorsVisible: false,
      },
    });
  });

  it("applies backend-owned visibility overrides before local target overrides", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    const visualizationState = {
      overrides: [
        {
          scope: "object",
          scope_id: "free-layer",
          visible: false,
        },
      ],
      revision: 12,
    };

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: visualizationState as never,
      }),
    ).toMatchObject({
      effectiveSettings: {
        shaderVisible: false,
        vectorsVisible: false,
      },
      override: {
        visible: false,
      },
      settings: {
        visible: false,
      },
    });

    controller.patchTarget(target, { visible: true });

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: visualizationState as never,
      }),
    ).toMatchObject({
      override: {
        visible: true,
      },
      settings: {
        visible: true,
      },
    });
  });

  it("maps backend-owned display and style overrides into target settings", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: {
          overrides: [
            {
              display: {
                geometry_scope: "surface",
                opacity: 0.35,
                surface: { visible: false },
                vectors: { visible: true },
                visible: true,
                wireframe: { opacity: 0.45, visible: true },
              },
              scope: "object",
              scope_id: "free-layer",
              style: {
                surface_color_source: "solid",
                surface_mono_color: "#00ffaa",
                vector_alpha: 0.4,
                vector_color_mode: "x",
                vector_mono_color: "#ff00aa",
                vector_thickness: 2,
                wireframe_color: "#111111",
              },
            },
          ],
          revision: 13,
        } as never,
      }),
    ).toMatchObject({
      settings: {
        geometryScope: "surface",
        opacityPercent: 35,
        shaderMonoColor: "#00ffaa",
        shaderVisible: false,
        surfaceColorSource: "solid",
        vectorAlphaPercent: 40,
        vectorColorMode: "x",
        vectorMonoColor: "#ff00aa",
        vectorThickness: 2,
        vectorsVisible: true,
        visible: true,
        wireframeColor: "#111111",
        wireframeOpacityPercent: 45,
        wireframeVisible: true,
      },
    });
  });

  it("serializes target patches into backend-owned display and style overrides", () => {
    expect(
      visualizationStateOverrideFromTargetPatch(
        { id: "free-layer", kind: "object" },
        {
          geometryScope: "surface",
          opacityPercent: 35,
          shaderMonoColor: "#00ffaa",
          surfaceColorSource: "solid",
          vectorAlphaPercent: 40,
          vectorColorMode: "x",
          vectorMonoColor: "#ff00aa",
          vectorThickness: 2,
          vectorsVisible: false,
          visible: true,
          wireframeColor: "#111111",
          wireframeOpacityPercent: 45,
          wireframeVisible: true,
        },
      ),
    ).toMatchObject({
      display: {
        geometry_scope: "surface",
        opacity: 0.35,
        vectors: { visible: false },
        visible: true,
        wireframe: { opacity: 0.45, visible: true },
      },
      scope: "object",
      scope_id: "free-layer",
      style: {
        surface_color_source: "solid",
        surface_mono_color: "#00ffaa",
        vector_alpha: 0.4,
        vector_color_mode: "x",
        vector_mono_color: "#ff00aa",
        vector_thickness: 2,
        wireframe_color: "#111111",
      },
      visible: true,
    });
  });

  it("applies global object display defaults before per-target overrides", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    controller.patchDefaults("object", {
      boundsVisible: true,
      vectorsVisible: true,
    });

    expect(controller.getSettings(target)).toMatchObject({
      boundsVisible: true,
      vectorsVisible: true,
    });

    controller.patchTarget(target, {
      boundsVisible: false,
    });

    expect(controller.getSettings(target)).toMatchObject({
      boundsVisible: false,
      vectorsVisible: true,
    });

    controller.clearDefaults("object");

    expect(controller.getSettings(target)).toMatchObject({
      boundsVisible: false,
      vectorsVisible: false,
    });
  });

  it("maps backend airbox layer state into target visualization settings", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        layers: {
          airbox: {
            opacity: 0.31,
            points: { opacity: 1, visible: true },
            surface: { opacity: 1, visible: false },
            vectors: { density: 64, domain: "airbox_only", visible: true },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
      }),
    ).toMatchObject({
      opacityPercent: 31,
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      vectorsVisible: true,
      visible: true,
      wireframeVisible: true,
    });
  });

  it("derives effective pass visibility from the target master visibility", () => {
    const configured = resolveAirboxVisualizationSettingsFromState({
      layers: {
        airbox: {
          opacity: 0.31,
          points: { opacity: 1, visible: true },
          surface: { opacity: 1, visible: true },
          vectors: { density: 64, domain: "airbox_only", visible: true },
          visible: false,
          wireframe: { opacity: 1, visible: true },
        },
      },
    });

    expect(configured).toMatchObject({
      pointsVisible: true,
      shaderVisible: true,
      vectorsVisible: true,
      visible: false,
      wireframeVisible: true,
    });
    expect(resolveEffectiveVisualizationSettings(configured)).toMatchObject({
      boundsVisible: false,
      pointsVisible: false,
      shaderVisible: false,
      vectorsVisible: false,
      visible: false,
      wireframeVisible: false,
    });
  });

  it("builds backend airbox layer patches from target display patches", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        boundsVisible: true,
        opacityPercent: 25,
        shaderVisible: true,
        vectorsVisible: true,
        visible: false,
        wireframeVisible: false,
      }),
    ).toEqual({
      layers: {
        airbox: {
          bounds: { visible: true },
          opacity: 0.25,
          surface: { visible: true },
          vectors: { domain: "airbox_only", visible: true },
          visible: false,
          wireframe: { visible: false },
        },
      },
    });
  });

  it("keeps only unsupported airbox target fields out of backend state patches", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        geometryScope: "full",
      }),
    ).toEqual({});
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        boundsVisible: true,
        geometryScope: "full",
        visible: false,
        wireframeVisible: false,
      }),
    ).toEqual({ geometryScope: "full" });
  });

  it("builds backend global visualization state patches from default target patches", () => {
    expect(
      visualizationStatePatchFromDefaultTargetPatch({
        boundsVisible: true,
        opacityPercent: 42,
        pointsVisible: true,
        shaderMonoColor: "#00ffaa",
        surfaceColorSource: "solid",
        vectorsVisible: true,
        wireframeOpacityPercent: 65,
        wireframeVisible: false,
      }),
    ).toEqual({
      layers: {
        bounds: { visible: true },
        points: { visible: true },
        surface: { opacity: 0.42 },
        vectors: { visible: true },
        wireframe: { opacity: 0.65, visible: false },
      },
      vector_glyphs: true,
      vector_style: {
        color_mode: "monochrome",
        mono_color: "#00ffaa",
      },
    });
  });
});
