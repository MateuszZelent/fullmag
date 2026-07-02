import { describe, expect, it } from "vitest";

import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
  mergeVisualizationStateTargetOverride,
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
  type VisualizationTargetPatch,
} from "./ObjectVisualizationController";

describe("ObjectVisualizationController", () => {
  it("keeps production style defaults for object and airbox targets", () => {
    expect(DEFAULT_OBJECT_VISUALIZATION).toMatchObject({
      geometryScope: "surface",
      opacityPercent: 100,
      pointColor: "var(--fm-border-strong)",
      primitiveVisible: false,
      renderMode: "surface+edges",
      shaderColorMode: "orientation",
      shaderMonoColor: "var(--fm-surface-magnetic)",
      shaderVisible: true,
      surfaceColorSource: "orientation",
      vectorAlphaPercent: 100,
      vectorColorMode: "orientation",
      vectorMonoColor: "var(--fm-accent)",
      vectorSurfaceOffsetScale: 0,
      vectorThickness: 1,
      vectorsVisible: false,
      wireframeColor: "var(--fm-border-strong)",
      wireframeOpacityPercent: 100,
      wireframeVisible: true,
    });
    expect(DEFAULT_AIRBOX_VISUALIZATION).toMatchObject({
      activeQuantityId: "H_demag",
      geometryScope: "full",
      opacityPercent: 28,
      pointColor: "var(--fm-info)",
      renderMode: "surface",
      shaderColorMode: "monochrome",
      shaderMonoColor: "var(--fm-airbox-fill)",
      shaderVisible: true,
      surfaceColorSource: "solid",
      vectorAlphaPercent: 100,
      vectorColorMode: "orientation",
      vectorMonoColor: "var(--fm-info)",
      vectorSurfaceOffsetScale: 0,
      vectorThickness: 1,
      vectorsVisible: false,
      wireframeColor: "var(--fm-airbox-wire)",
      wireframeOpacityPercent: 100,
      wireframeVisible: false,
      airboxSyntheticVectorsEnabled: false,
    });
  });

  it("keeps region visualization hidden by default", () => {
    const controller = new ObjectVisualizationController();
    const target = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };

    expect(controller.getSettings(target)).toMatchObject({
      activeQuantityId: "m",
      shaderVisible: false,
      vectorsVisible: false,
      visible: false,
      wireframeVisible: false,
    });
    expect(resolveEffectiveVisualizationSettings(controller.getSettings(target)))
      .toMatchObject({
        shaderVisible: false,
        vectorsVisible: false,
        wireframeVisible: false,
      });
  });

  it("uses one canonical object target key for raw and prefixed object ids", () => {
    const controller = new ObjectVisualizationController();
    const rawTarget = { id: "film", kind: "object" as const };
    const canonicalTarget = { id: "object:film", kind: "object" as const };
    const geometryTarget = { id: "object:film_geom", kind: "object" as const };

    controller.patchTarget(rawTarget, { visible: false });

    expect(visualizationTargetKey(rawTarget)).toBe(
      visualizationTargetKey(canonicalTarget),
    );
    expect(visualizationTargetKey(geometryTarget)).toBe(
      visualizationTargetKey(canonicalTarget),
    );
    expect(controller.getSettings(canonicalTarget)).toMatchObject({
      visible: false,
    });
    expect(controller.getSettings(geometryTarget)).toMatchObject({
      visible: false,
    });
    expect(Object.keys(controller.getSnapshot().overrides)).toEqual([
      visualizationTargetKey(canonicalTarget),
    ]);
  });

  it("patches and normalizes per-target shader point wireframe and vector style fields", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "arch", kind: "object" as const };

    controller.patchTarget(target, {
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ff3366",
      vectorAlphaPercent: 144,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorSurfaceOffsetScale: 2,
      vectorThickness: -3,
      pointColor: "#22ff99",
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
      vectorSurfaceOffsetScale: 1,
      vectorThickness: 0.1,
      pointColor: "#22ff99",
      wireframeColor: "#111111",
      wireframeOpacityPercent: 0,
    });
  });

  it("canonicalizes per-target quantity aliases when patching local settings", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "arch", kind: "object" as const };

    controller.patchTarget(target, { activeQuantityId: "h_eff" });

    expect(controller.getSettings(target).activeQuantityId).toBe("H_eff");
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
        pointColor: "#66eeff",
        wireframeColor: "#888888",
        wireframeOpacityPercent: 75,
        airboxSyntheticVectorsEnabled: true,
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
        pointColor: "#66eeff",
        wireframeColor: "#888888",
        wireframeOpacityPercent: 75,
        airboxSyntheticVectorsEnabled: true,
      }),
    ).toEqual({
      airboxSyntheticVectorsEnabled: true,
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ffffff",
      surfaceColorSource: "solid",
      vectorAlphaPercent: 44,
      vectorColorMode: "magnitude",
      vectorThickness: 2,
      pointColor: "#66eeff",
      wireframeColor: "#888888",
      wireframeOpacityPercent: 75,
    });
  });

  it("serializes airbox vector length and thickness as per-airbox overrides", () => {
    const patch = airboxVisualizationStatePatchFromTargetPatch(
      {
        vectorLengthScale: 2.25,
        vectorThickness: 1.5,
      },
      [],
    );

    expect(patch).toEqual({
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          style: {
            vector_length_scale: 2.25,
            vector_thickness: 1.5,
          },
        },
      ],
    });
    expect(patch).not.toHaveProperty("vector_style");
  });

  it("keeps airbox vector length in local optimistic patches", () => {
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        vectorLengthScale: 2,
      }),
    ).toEqual({
      vectorLengthScale: 2,
    });
  });

  it("resolves canonical target ids from object and airbox selections", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
        ref: null,
      }),
    ).toEqual({
      id: "object:free-layer",
      kind: "object",
      label: "Free layer",
    });

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
        ref: {
          kind: "object.visualization",
          nodeId: "model:object:free-layer:visualization",
          objectId: "free-layer",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      }),
    ).toEqual({
      id: "object:free-layer",
      kind: "object",
      label: "Free layer",
    });

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.visualization",
        label: "Airbox Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
        ref: null,
      }),
    ).toEqual(AIRBOX_VISUALIZATION_TARGET);

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.region.visualization",
        label: "Core region",
        nodeId: "model:object:free-layer:regions:core:visualization",
        objectId: "free-layer",
        ref: {
          kind: "object.region.visualization",
          nodeId: "model:object:free-layer:regions:core:visualization",
          objectId: "free-layer",
          regionId: "region:core",
          type: "scene-object",
          visualizationTargetId: "region:free-layer:region%3Acore",
        },
      }),
    ).toEqual({
      id: "region:free-layer:region%3Acore",
      kind: "region",
      label: "Core region",
    });
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
        pointsVisible: false,
        shaderVisible: false,
        wireframeVisible: true,
      });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(target)])
      .not.toHaveProperty("renderMode");

    controller.clearTarget(target);

    expect(controller.getSettings(target)).toMatchObject({
      opacityPercent: 100,
      renderMode: "surface+edges",
    });
  });

  it("stores region visualization overrides independently from the owner object", () => {
    const controller = new ObjectVisualizationController();
    const objectTarget = { id: "film", kind: "object" as const };
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };

    controller.patchTarget(objectTarget, { visible: false });
    controller.patchTarget(regionTarget, { opacityPercent: 35 });

    expect(controller.getSnapshot().overrides[visualizationTargetKey(objectTarget)])
      .toMatchObject({ visible: false });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(regionTarget)])
      .toMatchObject({ opacityPercent: 35 });
    expect(controller.getSettings(regionTarget)).toMatchObject({
      opacityPercent: 35,
      visible: false,
    });
  });

  it("inherits owner visualization settings before applying region overrides", () => {
    const controller = new ObjectVisualizationController();
    const objectTarget = { id: "film", kind: "object" as const };
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };

    controller.patchTarget(objectTarget, {
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: true,
    });
    controller.patchTarget(regionTarget, { wireframeVisible: false });

    const owner = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target: objectTarget,
    });
    const region = resolveTargetVisualization({
      inheritedSettings: owner.settings,
      snapshot: controller.getSnapshot(),
      target: regionTarget,
    });

    expect(region.settings).toMatchObject({
      shaderVisible: false,
      vectorsVisible: false,
      wireframeVisible: false,
      visible: false,
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

  it("keeps display-pass toggles editable after a render-mode override", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "arch-waveguide", kind: "object" as const };

    controller.patchTarget(target, {
      geometryScope: "full",
      ...renderModePatch("surface+edges"),
    });
    controller.patchTarget(target, { shaderVisible: false });

    expect(controller.getSettings(target)).toMatchObject({
      geometryScope: "full",
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });

    controller.patchTarget(target, { pointsVisible: true });

    expect(controller.getSettings(target)).toMatchObject({
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      wireframeVisible: true,
    });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(target)])
      .not.toHaveProperty("renderMode");
  });

  it("stores global render-mode defaults as canonical display flags", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "arch-waveguide", kind: "object" as const };

    controller.patchDefaults("object", renderModePatch("points"));

    expect(controller.getSettings(target)).toMatchObject({
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      wireframeVisible: false,
    });
    expect(controller.getSnapshot().defaults.object).toMatchObject({
      pointsVisible: true,
      shaderVisible: false,
      wireframeVisible: false,
    });
    expect(controller.getSnapshot().defaults.object).not.toHaveProperty(
      "renderMode",
    );
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
      vector_style: {
        length_scale: 2.25,
      },
    };

    expect(
      resolveGlobalObjectVisualizationSettings(visualizationState as never),
    ).toMatchObject({
      vectorBudget: 512,
      vectorLengthScale: 2.25,
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
        vectorBudget: 512,
        vectorLengthScale: 2.25,
        vectorsVisible: true,
      },
      override: null,
      revision: "0:11",
      settings: {
        vectorBudget: 512,
        vectorLengthScale: 2.25,
        vectorsVisible: true,
      },
    });

    controller.patchTarget(target, {
      vectorBudget: 64,
      vectorLengthScale: 0.75,
      vectorsVisible: false,
    });

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: visualizationState as never,
      }),
    ).toMatchObject({
      effectiveSettings: {
        vectorBudget: 64,
        vectorLengthScale: 0.75,
        vectorsVisible: false,
      },
      override: {
        vectorBudget: 64,
        vectorLengthScale: 0.75,
        vectorsVisible: false,
      },
      revision: "1:11",
      settings: {
        vectorBudget: 64,
        vectorLengthScale: 0.75,
        vectorsVisible: false,
      },
    });
  });

  it("keeps primitive fallback disabled by default even when visualization state has a primitive layer", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        layers: {
          primitives: {
            opacity: 1,
            visible: true,
          },
        },
      } as never),
    ).toMatchObject({
      primitiveVisible: false,
    });
  });

  it("uses canonical sampling max glyphs before legacy vector density", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        layers: {
          vectors: {
            density: 512,
            domain: "full_domain",
            visible: true,
          },
        },
        sampling: {
          max_glyphs: 1536,
        },
        vector_density: 256,
        vector_glyphs: true,
      } as never),
    ).toMatchObject({
      vectorBudget: 1536,
      vectorsVisible: true,
    });
  });

  it("defaults scalar surface quantities to colormap instead of vector orientation coloring", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        quantity: { active_quantity_id: "mat_ms" },
        vector_style: { color_mode: "orientation" },
      } as never),
    ).toMatchObject({
      activeQuantityId: "mat_ms",
      shaderColorMode: "magnitude",
      surfaceColorSource: "colormap",
      vectorColorMode: "orientation",
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

  it("matches backend object overrides that use geometry suffixed scope ids", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "object:free-layer", kind: "object" as const };
    const visualizationState = {
      overrides: [
        {
          display: { wireframe: { visible: true } },
          scope: "object",
          scope_id: "free-layer_geom",
          visible: true,
        },
      ],
      revision: 12,
    };

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: visualizationState as never,
      }).settings,
    ).toMatchObject({
      visible: true,
      wireframeVisible: true,
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
                scalar_color_palette: "inferno",
                surface_color_source: "solid",
                surface_projection_mode: "surface_faces",
                surface_mono_color: "#00ffaa",
                vector_alpha: 0.4,
                vector_budget: 384,
                vector_color_mode: "x",
                vector_length_scale: 1.75,
                vector_mono_color: "#ff00aa",
                vector_thickness: 2,
                point_color: "#66eeff",
                wireframe_color: "#111111",
              },
              quantity: {
                active_quantity_id: "h_demag",
              },
            },
          ],
          quantity: { active_quantity_id: "m" },
          revision: 13,
        } as never,
      }),
    ).toMatchObject({
      settings: {
        activeQuantityId: "H_demag",
        geometryScope: "surface",
        opacityPercent: 35,
        scalarColorPalette: "inferno",
        shaderMonoColor: "#00ffaa",
        shaderVisible: false,
        surfaceColorSource: "solid",
        surfaceProjectionMode: "surface_faces",
        vectorAlphaPercent: 40,
        vectorBudget: 384,
        vectorColorMode: "x",
        vectorLengthScale: 1.75,
        vectorMonoColor: "#ff00aa",
        vectorThickness: 2,
        pointColor: "#66eeff",
        vectorsVisible: true,
        visible: true,
        wireframeColor: "#111111",
        wireframeOpacityPercent: 45,
        wireframeVisible: true,
      },
    });
  });

  it("serializes target patches into backend-owned display and style overrides", () => {
    const patchWithProjection = {
      geometryScope: "surface",
      opacityPercent: 35,
      scalarColorPalette: "inferno",
      shaderMonoColor: "#00ffaa",
      surfaceColorSource: "solid",
      surfaceProjectionMode: "surface_faces",
      vectorAlphaPercent: 40,
      vectorBudget: 384,
      vectorColorMode: "x",
      vectorLengthScale: 1.75,
      vectorMonoColor: "#ff00aa",
      vectorThickness: 2,
      pointColor: "#66eeff",
      vectorsVisible: false,
      visible: true,
      wireframeColor: "#111111",
      wireframeOpacityPercent: 45,
      wireframeVisible: true,
      activeQuantityId: "h_eff",
    } satisfies VisualizationTargetPatch & { surfaceProjectionMode: "surface_faces" };

    expect(
      visualizationStateOverrideFromTargetPatch(
        { id: "free-layer", kind: "object" },
        patchWithProjection,
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
      quantity: {
        active_quantity_id: "H_eff",
      },
      style: {
        scalar_color_palette: "inferno",
        surface_color_source: "solid",
        surface_projection_mode: "surface_faces",
        surface_mono_color: "#00ffaa",
        point_color: "#66eeff",
        vector_alpha: 0.4,
        vector_budget: 384,
        vector_color_mode: "x",
        vector_length_scale: 1.75,
        vector_mono_color: "#ff00aa",
        vector_thickness: 2,
        wireframe_color: "#111111",
      },
      visible: true,
    });
  });

  it("defaults target surface projection to raw nodal", () => {
    expect(DEFAULT_OBJECT_VISUALIZATION).toMatchObject({
      surfaceProjectionMode: "raw_nodal",
    });
    expect(DEFAULT_AIRBOX_VISUALIZATION).toMatchObject({
      surfaceProjectionMode: "raw_nodal",
    });
  });

  it("serializes zero as an explicit vector budget", () => {
    expect(
      visualizationStateOverrideFromTargetPatch(
        { id: "free-layer", kind: "object" },
        { vectorBudget: 0 },
      ),
    ).toMatchObject({
      scope: "object",
      scope_id: "free-layer",
      style: {
        vector_budget: 0,
      },
    });

    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        vectorBudget: 0,
      }),
    ).toEqual({
      layers: {
        airbox: {
          vectors: {
            density: 0,
            domain: "airbox_only",
          },
        },
      },
    });
  });

  it("merges legacy raw object overrides into canonical object targets", () => {
    expect(
      mergeVisualizationStateTargetOverride(
        [
          {
            scope: "object",
            scope_id: "free-layer",
            style: {
              surface_color_source: "solid",
              surface_mono_color: "#ffffff",
            },
          },
        ],
        { id: "object:free-layer", kind: "object" },
        {
          shaderMonoColor: "#00ffaa",
          vectorsVisible: true,
        },
      ),
    ).toEqual([
      {
        display: {
          vectors: {
            visible: true,
          },
        },
        scope: "object",
        scope_id: "free-layer",
        style: {
          surface_color_source: "solid",
          surface_mono_color: "#00ffaa",
        },
      },
    ]);
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
      vectorBudget: 64,
      vectorsVisible: true,
      visible: true,
      wireframeVisible: true,
    });
  });

  it("derives airbox render mode from canonical display flags", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        targets: {
          airbox: {
            label: "Airbox",
            scope: "airbox",
            scope_id: "airbox",
            settings: {
              active_quantity_id: "H_demag",
              bounds_visible: false,
              geometry_scope: "full",
              opacity: 0.28,
              point_color: "var(--fm-info)",
              points_visible: false,
              render_mode: "surface",
              scalar_color_palette: "viridis",
              surface_color_source: "solid",
              surface_projection_mode: "raw_nodal",
              surface_mono_color: "var(--fm-airbox-fill)",
              surface_visible: false,
              viewport_colorbar_visible: false,
              vector_alpha: 1,
              vector_budget: 1200,
              vector_color_mode: "orientation",
              vector_length_scale: 1,
              vector_mono_color: "var(--fm-info)",
              vector_thickness: 1,
              vectors_visible: false,
              visible: true,
              wireframe_color: "var(--fm-airbox-wire)",
              wireframe_opacity: 1,
              wireframe_visible: true,
            },
            source: "airbox",
          },
          objects: [],
          parts: [],
        },
      }),
    ).toMatchObject({
      pointsVisible: false,
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });
  });

  it("uses the target registry as the airbox geometry and style source", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        layers: {
          airbox: {
            opacity: 0.31,
            points: { opacity: 1, visible: false },
            surface: { opacity: 1, visible: false },
            vectors: { density: 64, domain: "airbox_only", visible: false },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
        targets: {
          airbox: {
            label: "Airbox",
            scope: "airbox",
            scope_id: "airbox",
            settings: {
              ...DEFAULT_AIRBOX_VISUALIZATION,
              active_quantity_id: "h_eff",
              bounds_visible: true,
              geometry_scope: "surface",
              opacity: 0.28,
              points_visible: false,
              render_mode: "wireframe",
              scalar_color_palette: "inferno",
              surface_color_source: "solid",
              surface_projection_mode: "raw_nodal",
              surface_mono_color: "#112233",
              surface_visible: false,
              viewport_colorbar_visible: false,
              vector_alpha: 0.5,
              vector_budget: 256,
              vector_color_mode: "x",
              vector_length_scale: 1.75,
              vector_mono_color: "#445566",
              vector_thickness: 1.5,
              point_color: "#123abc",
              vectors_visible: false,
              visible: true,
              wireframe_color: "#778899",
              wireframe_opacity: 0.4,
              wireframe_visible: true,
            },
            source: "airbox",
          },
          objects: [],
          parts: [],
        },
      }),
    ).toMatchObject({
      boundsVisible: true,
      geometryScope: "surface",
      opacityPercent: 31,
      scalarColorPalette: "inferno",
      shaderMonoColor: "#112233",
      vectorAlphaPercent: 50,
      vectorBudget: 256,
      vectorColorMode: "x",
      vectorLengthScale: 1.75,
      vectorMonoColor: "#445566",
      vectorThickness: 1.5,
      pointColor: "#123abc",
      wireframeColor: "#778899",
      wireframeOpacityPercent: 40,
    });
  });

  it("keeps airbox quantity target patches addressable locally and remotely", () => {
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        activeQuantityId: "h_eff",
      }),
    ).toEqual({
      activeQuantityId: "h_eff",
    });

    expect(
      airboxVisualizationStatePatchFromTargetPatch(
        {
          activeQuantityId: "h_eff",
        },
        [
          {
            scope: "object",
            scope_id: "free-layer",
            quantity: {
              active_quantity_id: "h_demag",
            },
          },
        ],
      ),
    ).toEqual({
      overrides: [
        {
          scope: "object",
          scope_id: "free-layer",
          quantity: {
            active_quantity_id: "H_demag",
          },
        },
        {
          scope: "airbox",
          scope_id: "airbox",
          quantity: {
            active_quantity_id: "H_eff",
          },
        },
      ],
    });
  });

  it("prefers backend airbox target quantity over the global quantity", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        active_quantity_id: "m",
        quantity: { active_quantity_id: "m" },
        targets: {
          airbox: {
            label: "Airbox",
            scope: "airbox",
            scope_id: "airbox",
            settings: {
              active_quantity_id: "H_demag",
              bounds_visible: false,
              geometry_scope: "full",
              opacity: 0.28,
              point_color: "var(--fm-info)",
              points_visible: false,
              render_mode: "surface",
              scalar_color_palette: "viridis",
              surface_color_source: "solid",
              surface_projection_mode: "raw_nodal",
              surface_mono_color: "var(--fm-airbox-fill)",
              surface_visible: true,
              viewport_colorbar_visible: false,
              vector_alpha: 1,
              vector_budget: 1200,
              vector_color_mode: "orientation",
              vector_length_scale: 1,
              vector_mono_color: "var(--fm-info)",
              vector_thickness: 1,
              vectors_visible: false,
              visible: true,
              wireframe_color: "var(--fm-airbox-wire)",
              wireframe_opacity: 1,
              wireframe_visible: false,
            },
            source: "airbox",
          },
          objects: [],
          parts: [],
        },
      }).activeQuantityId,
    ).toBe("H_demag");
  });

  it("falls back to canonical visualization quantity before compatibility quantity", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        active_quantity_id: "m",
        quantity: { active_quantity_id: "H_demag" },
      }).activeQuantityId,
    ).toBe("H_demag");
  });

  it("does not inherit global H_eff quantity into airbox compatibility state", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        active_quantity_id: "H_eff",
        quantity: { active_quantity_id: "H_eff" },
      }).activeQuantityId,
    ).toBe("H_demag");
  });

  it("canonicalizes serialized target quantity patches", () => {
    expect(
      visualizationStateOverrideFromTargetPatch(
        { id: "free-layer", kind: "object" },
        { activeQuantityId: "h_eff" },
      ),
    ).toMatchObject({
      quantity: { active_quantity_id: "H_eff" },
    });
  });

  it("updates stale backend airbox visibility overrides when patching layer visibility", () => {
    const patch = airboxVisualizationStatePatchFromTargetPatch(
      {
        visible: true,
      },
      [
        {
          display: {
            visible: false,
          },
          quantity: {
            active_quantity_id: "H_demag",
          },
          scope: "airbox",
          scope_id: "airbox",
          visible: false,
        },
      ],
    );

    expect(patch).toMatchObject({
      layers: {
        airbox: {
          surface: { visible: true },
          visible: true,
        },
      },
      overrides: [
        {
          display: {
            surface: { visible: true },
            visible: true,
          },
          quantity: {
            active_quantity_id: "H_demag",
          },
          scope: "airbox",
          scope_id: "airbox",
          visible: true,
        },
      ],
    });
    expect(patch.overrides).toHaveLength(1);
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
        vectorBudget: 64,
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
          vectors: { density: 64, domain: "airbox_only", visible: true },
          visible: false,
          wireframe: { visible: false },
        },
      },
    });
  });

  it("combines backend airbox layer patches with per-airbox style overrides", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch(
        {
          vectorBudget: 64,
          vectorLengthScale: 2.25,
          vectorThickness: 1.5,
          vectorsVisible: true,
        },
        [],
      ),
    ).toEqual({
      layers: {
        airbox: {
          vectors: { density: 64, domain: "airbox_only", visible: true },
        },
      },
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          style: {
            vector_length_scale: 2.25,
            vector_thickness: 1.5,
          },
        },
      ],
    });
  });

  it("enables the default airbox surface when master visibility is turned on without active passes", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        visible: true,
      }),
    ).toEqual({
      layers: {
        airbox: {
          surface: { visible: true },
          visible: true,
        },
      },
    });
  });

  it("does not force airbox wireframe when visibility patch includes an explicit drawable pass", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        shaderVisible: true,
        visible: true,
      }),
    ).toEqual({
      layers: {
        airbox: {
          surface: { visible: true },
          visible: true,
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
        vectorBudget: 64,
        vectorLengthScale: 2,
        visible: false,
        wireframeVisible: false,
      }),
    ).toEqual({ geometryScope: "full", vectorLengthScale: 2 });
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
