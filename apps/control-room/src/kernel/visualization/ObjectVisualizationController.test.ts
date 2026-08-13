import { describe, expect, it } from "vitest";

import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_FDM_DOMAIN_VISUALIZATION,
  DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
  ObjectVisualizationController,
  mergeVisualizationStateTargetOverride,
  removeTargetOverrideField,
  renderModePatch,
  resolveAirboxVisualizationSettingsFromState,
  resetAirboxVisualizationState,
  resolveEffectiveVisualizationSettings,
  resolveFdmViewportVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
  visualizationStateOverrideFromTargetPatch,
  resolveVisualizationSettings,
  resolveVisualizationTargetFromSelection,
  visualizationStatePatchFromDefaultTargetPatch,
  visualizationTargetCapabilities,
  visualizationTargetKey,
  type VisualizationTargetPatch,
} from "./ObjectVisualizationController";

describe("ObjectVisualizationController", () => {
  it("keeps production style defaults for object and airbox targets", () => {
    expect(DEFAULT_OBJECT_VISUALIZATION).toMatchObject({
      geometryScope: "surface",
      surfaceOpacityPercent: 100,
      pointColor: "var(--fm-border-strong)",
      primitiveVisible: false,
      renderMode: "surface",
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
      wireframeVisible: false,
    });
    expect(DEFAULT_AIRBOX_VISUALIZATION).toMatchObject({
      activeQuantityId: "H_demag",
      geometryScope: "full",
      surfaceOpacityPercent: 28,
      pointColor: "var(--fm-info)",
      renderMode: "off",
      shaderColorMode: "monochrome",
      shaderMonoColor: "var(--fm-airbox-fill)",
      shaderVisible: false,
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
      visible: true,
    });
  });

  it("preserves a magnetic-only quantity for catalog gating", () => {
    const resolved = resolveTargetVisualization({
      snapshot: new ObjectVisualizationController().getSnapshot(),
      target: AIRBOX_VISUALIZATION_TARGET,
      visualizationState: {
        revision: 3,
        targets: {
          airbox: {
            scope: "airbox",
            scope_id: "airbox",
            settings: {
              active_quantity_id: "m",
            },
          },
          objects: [],
          parts: [],
        },
      } as never,
    });

    expect(resolved.settings.activeQuantityId).toBe("m");
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

  it("limits Airbox rendering to wireframe, points, and field vectors", () => {
    expect(visualizationTargetCapabilities(AIRBOX_VISUALIZATION_TARGET)).toEqual({
      primaryRenderModes: ["wireframe", "points"],
      showBoundsControl: true,
      showGeometryScopeControl: true,
      supportsFieldData: true,
      supportsPoints: true,
      supportsVectors: true,
    });
    expect(visualizationTargetCapabilities({ id: "film", kind: "object" })).toEqual({
      primaryRenderModes: ["surface", "surface+edges", "wireframe", "points"],
      showBoundsControl: true,
      showGeometryScopeControl: true,
      supportsFieldData: true,
      supportsPoints: true,
      supportsVectors: true,
    });
  });

  it("keeps vector field settings but rejects shader and point settings on the FDM Airbox target", () => {
    const controller = new ObjectVisualizationController();

    controller.patchTarget(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET, {
      activeQuantityId: "H_demag",
      shaderVisible: true,
      surfaceColorSource: "magnitude",
      vectorBudget: 400,
      vectorsVisible: true,
      vectorColorMode: "magnitude",
      viewportColorbarVisible: true,
    });

    expect(controller.getSettings(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)).toMatchObject({
      activeQuantityId: "H_demag",
      shaderVisible: false,
      surfaceColorSource: "solid",
      vectorBudget: 400,
      vectorColorMode: "magnitude",
      vectorsVisible: true,
      viewportColorbarVisible: false,
    });
    expect(controller.getSnapshot().overrides).toEqual({
      [FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id]: {
        activeQuantityId: "H_demag",
        vectorBudget: 400,
        vectorColorMode: "magnitude",
        vectorsVisible: true,
      },
    });
  });

  it("preserves generic Airbox points while rejecting the unsupported shader pass", () => {
    const controller = new ObjectVisualizationController();

    controller.patchTarget(AIRBOX_VISUALIZATION_TARGET, {
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: true,
      surfaceColorSource: "magnitude",
      vectorsVisible: true,
      vectorBudget: 256,
    });

    expect(controller.getSettings(AIRBOX_VISUALIZATION_TARGET)).toMatchObject({
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      surfaceColorSource: "solid",
      vectorBudget: 256,
      vectorsVisible: true,
    });
  });

  it("exposes points as a primary geometry mode for FEM and FDM Airbox targets", () => {
    expect(visualizationTargetCapabilities(AIRBOX_VISUALIZATION_TARGET)).toMatchObject({
      primaryRenderModes: ["wireframe", "points"],
      supportsPoints: true,
    });
    expect(visualizationTargetCapabilities(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)).toMatchObject({
      primaryRenderModes: ["wireframe", "points"],
      supportsPoints: true,
    });
  });

  it("normalizes surface render-mode patches and stale field overrides to FDM Airbox wireframe", () => {
    const controller = new ObjectVisualizationController();

    controller.patchTarget(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET, {
      renderMode: "surface",
    });
    expect(visualizationTargetCapabilities(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET))
      .toMatchObject({ primaryRenderModes: ["wireframe", "points"] });
    expect(controller.getSettings(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)).toMatchObject({
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });

    const stale = resolveTargetVisualization({
      snapshot: {
        defaults: {},
        overrides: {
          "fdm-universe-outside-support": {
            activeQuantityId: "H_demag",
            pointsVisible: true,
            shaderVisible: true,
            surfaceColorSource: "magnitude",
            vectorsVisible: true,
          },
        },
        version: 1,
      },
      target: FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
    });

    expect(stale.settings).toMatchObject({
      activeQuantityId: "H_demag",
      pointsVisible: true,
      shaderVisible: false,
      surfaceColorSource: "solid",
      vectorsVisible: true,
      wireframeVisible: true,
    });
  });

  it("maps supported FDM Airbox render modes to wireframe state without storing a renderMode override", () => {
    const controller = new ObjectVisualizationController();

    controller.patchTarget(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET, {
      renderMode: "off",
    });

    expect(controller.getSettings(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)).toMatchObject({
      renderMode: "off",
      shaderVisible: false,
      wireframeVisible: false,
    });
    expect(
      controller.getSnapshot().overrides[
        FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
      ],
    ).toEqual({ pointsVisible: false, wireframeVisible: false });

    controller.patchTarget(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET, {
      renderMode: "wireframe",
    });

    expect(controller.getSettings(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)).toMatchObject({
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });
    expect(
      controller.getSnapshot().overrides[
        FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
      ],
    ).toEqual({ pointsVisible: false, wireframeVisible: true });
  });

  it("keeps field and vector capabilities on the magnetic FDM domain", () => {
    const target = { id: "fdm-domain", kind: "fdm-domain" as const };
    const controller = new ObjectVisualizationController();

    controller.patchTarget(target, {
      activeQuantityId: "H_demag",
      vectorsVisible: true,
    });

    expect(visualizationTargetCapabilities(target)).toMatchObject({
      supportsFieldData: true,
      supportsVectors: true,
    });
    expect(controller.getSettings(target)).toMatchObject({
      activeQuantityId: "H_demag",
      vectorsVisible: true,
    });
  });

  it("inherits every owner visualization setting except a sparse region override", () => {
    const controller = new ObjectVisualizationController();
    const objectTarget = {
      id: "object:film",
      kind: "object" as const,
      label: "film",
    };
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
      label: "core",
    };

    controller.patchTarget(objectTarget, {
      shaderVisible: true,
      surfaceColorSource: "component_x",
      visible: true,
      wireframeVisible: true,
    });
    controller.patchTarget(regionTarget, { activeQuantityId: "H_eff" });

    const snapshot = controller.getSnapshot();
    const objectSettings = resolveTargetVisualization({
      snapshot,
      target: objectTarget,
    }).settings;
    const regionSettings = resolveTargetVisualization({
      inheritedSettings: objectSettings,
      snapshot,
      target: regionTarget,
    }).settings;

    expect(regionSettings).toMatchObject({
      activeQuantityId: "H_eff",
      surfaceColorSource: "component_x",
      shaderVisible: true,
      vectorsVisible: false,
      visible: true,
      wireframeVisible: true,
    });
  });

  it("does not inherit global vector visibility for a region without parent context", () => {
    const controller = new ObjectVisualizationController();
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
      label: "core",
    };

    const resolved = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target: regionTarget,
      visualizationState: {
        layers: {
          vectors: {
            density: 512,
            domain: "full_domain",
            visible: true,
          },
        },
        revision: 12,
        vector_glyphs: true,
      } as never,
    });

    expect(resolved.settings).toMatchObject({
      shaderVisible: false,
      vectorsVisible: false,
      visible: false,
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

  it("serializes only wireframe and vector Airbox properties through one canonical patch", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        activeQuantityId: "h_eff",
        boundsVisible: true,
        geometryScope: "surface",
        surfaceOpacityPercent: 44,
        shaderColorMode: "monochrome",
        shaderMonoColor: "#ffffff",
        surfaceColorSource: "solid",
        surfaceProjectionMode: "surface_faces",
        viewportColorbarVisible: true,
        pointsVisible: true,
        vectorAlphaPercent: 44,
        vectorBudget: 256,
        vectorColorMode: "magnitude",
        vectorLengthScale: 1.5,
        vectorMonoColor: "#66aaff",
        vectorThickness: 2,
        vectorsVisible: true,
        pointColor: "#66eeff",
        scalarColorPalette: "inferno",
        wireframeColor: "#888888",
        wireframeOpacityPercent: 75,
        wireframeVisible: true,
        shaderVisible: true,
        visible: true,
      }, []),
    ).toMatchObject({
      layers: {
        airbox: {
          bounds: { visible: true },
          vectors: { density: 256, domain: "airbox_only", visible: true },
          visible: true,
          wireframe: { opacity: 0.75, visible: true },
        },
      },
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          display: {
            bounds: { visible: true },
            geometry_scope: "surface",
            vectors: { visible: true },
            visible: true,
            wireframe: { opacity: 0.75, visible: true },
          },
          quantity: { active_quantity_id: "H_eff" },
          style: {
            scalar_color_palette: "inferno",
            vector_alpha: 0.44,
            vector_budget: 256,
            vector_color_mode: "magnitude",
            vector_length_scale: 1.5,
            vector_mono_color: "#66aaff",
            vector_thickness: 2,
            wireframe_color: "#888888",
          },
          visible: true,
        },
      ],
    });
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
    });
  });

  it("resets airbox layers and removes its quantity and style override atomically", () => {
    expect(
      resetAirboxVisualizationState({
        layers: {
          airbox: {
            bounds: { opacity: 0.2, visible: true },
            points: { opacity: 0.3, visible: true },
            surface: { opacity: 0.4, visible: false },
          },
        },
        overrides: [
          {
            scope: "airbox",
            scope_id: "airbox",
            quantity: { active_quantity_id: "H_eff" },
            style: { vector_alpha: 0.4 },
          },
          {
            scope: "object",
            scope_id: "film",
            quantity: { active_quantity_id: "m" },
          },
        ],
      } as never),
    ).toMatchObject({
      layers: {
        airbox: {
          bounds: { opacity: 1, visible: false },
          vectors: { density: 1200, domain: "airbox_only", visible: false },
          visible: true,
          wireframe: { opacity: 1, visible: false },
        },
      },
      overrides: [
        {
          scope: "object",
          scope_id: "film",
          quantity: { active_quantity_id: "m" },
        },
      ],
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

  it("keeps only renderer-local airbox switches in local optimistic patches", () => {
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        vectorLengthScale: 2,
        vectorCenteringEnabled: false,
      }),
    ).toEqual({
      vectorCenteringEnabled: false,
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

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "mesh-part",
        label: "Film mesh",
        nodeId: "part-film",
        objectId: "projection-film",
        ref: {
          kind: "mesh-part",
          nodeId: "part-film",
          objectId: "projection-film",
          type: "mesh-part",
          visualizationTargetId: "mesh-part:part-film",
        },
      }),
    ).toEqual({
      id: "object:projection-film",
      kind: "object",
      label: "Film mesh",
    });
  });

  it("resolves an FDM cell selection to the structured-grid visualization target", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "fdm.cell",
        label: "Cell 7",
        nodeId: "model:mesh:grid",
        objectId: null,
        ref: {
          cellOrdinal: "7",
          gridFingerprint: "grid-1",
          ijk: [1, 2, 0],
          kind: "fdm.cell",
          maskState: "active-unassigned",
          membershipRevision: "mesh-1:membership-1",
          nodeId: "model:mesh:grid",
          numericRegionId: 0,
          regionId: null,
          type: "fdm-cell",
          visualizationTargetId: "fdm-domain",
        },
      }),
    ).toEqual({
      id: "fdm-domain",
      kind: "fdm-domain",
      label: "Cell 7",
    });
  });

  it("does not fill the whole authored FDM universe before membership is realized", () => {
    const settings = DEFAULT_FDM_DOMAIN_VISUALIZATION;

    expect(settings).toMatchObject({
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
      visible: true,
    });
  });

  it("fail-closes shader and vectors while the FDM membership is unavailable", () => {
    const settings = resolveFdmViewportVisualizationSettings(
      {
        ...DEFAULT_FDM_DOMAIN_VISUALIZATION,
        shaderVisible: true,
        vectorsVisible: true,
      },
      false,
    );

    expect(settings).toMatchObject({
      renderMode: "wireframe",
      shaderVisible: false,
      surfaceColorSource: "solid",
      vectorsVisible: false,
    });
    expect(
      resolveFdmViewportVisualizationSettings(
        { ...DEFAULT_FDM_DOMAIN_VISUALIZATION, shaderVisible: true },
        true,
      ).shaderVisible,
    ).toBe(true);
  });

  it("resolves structured-grid Explorer selections to the same FDM target", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "mesh.grid.descriptor",
        label: "Structured Grid",
        nodeId: "model:mesh:grid",
        objectId: null,
        ref: {
          kind: "mesh.grid.descriptor",
          nodeId: "model:mesh:grid",
          scope: "descriptor",
          type: "fdm-domain",
          visualizationTargetId: "fdm-domain",
        },
      }),
    ).toEqual({
      id: "fdm-domain",
      kind: "fdm-domain",
      label: "Structured Grid",
    });
  });

  it("keeps native multilayer targets local and excludes FFT scratch selections", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "mesh.grid.layer",
        label: "Bottom layer",
        nodeId: "model:mesh:grid:layers:bottom",
        objectId: "bottom",
        ref: {
          kind: "mesh.grid.layer",
          layerId: "layer:bottom",
          nodeId: "model:mesh:grid:layers:bottom",
          scope: "layer",
          type: "fdm-domain",
          visualizationTargetId: "fdm-native-layer:layer%3Abottom",
        },
      }),
    ).toEqual({
      id: "fdm-native-layer:layer%3Abottom",
      kind: "fdm-native-layer",
      label: "Bottom layer",
    });
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "mesh.grid.common",
        label: "FFT scratch",
        nodeId: "model:mesh:grid:common",
        objectId: null,
        ref: {
          kind: "mesh.grid.common",
          nodeId: "model:mesh:grid:common",
          scope: "common",
          type: "fdm-domain",
          visualizationTargetId: "fdm-domain",
        },
      }),
    ).toBeNull();
    expect(
      visualizationStateOverrideFromTargetPatch(
        {
          id: "fdm-native-layer:layer%3Abottom",
          kind: "fdm-native-layer",
        },
        { visible: false },
      ),
    ).toBeNull();
  });

  it("preserves the dedicated FDM universe outside-support target from selection refs", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "mesh.grid.universe-outside-support",
        label: "Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
        ref: {
          kind: "mesh.grid.universe-outside-support",
          nodeId: "model:airbox:visualization",
          scope: "universe-outside-support",
          type: "fdm-domain",
          visualizationTargetId: "fdm-universe-outside-support",
        },
      }),
    ).toEqual(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET);
  });

  it("normalizes shared FDM Airbox child labels to the Airbox target", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.mesh",
        label: "Mesh",
        nodeId: "model:airbox:mesh",
        objectId: null,
        ref: {
          kind: "airbox.mesh",
          nodeId: "model:airbox:mesh",
          type: "airbox",
          visualizationTargetId: "fdm-universe-outside-support",
        },
      }),
    ).toEqual(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET);
  });

  it("keeps FDM universe outside-support settings isolated from the domain defaults", () => {
    const controller = new ObjectVisualizationController();
    const mainTarget = { id: "fdm-domain", kind: "fdm-domain" as const };

    controller.patchDefaults("fdm-domain", {
      surfaceOpacityPercent: 64,
      visible: false,
    });

    expect(controller.getSettings(mainTarget)).toMatchObject({
      surfaceOpacityPercent: 64,
      visible: false,
    });
    expect(controller.getSettings(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)).toMatchObject(
      {
        ...DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION,
        activeQuantityId: "H_demag",
      },
    );

    controller.patchTarget(mainTarget, { wireframeOpacityPercent: 11 });
    controller.patchTarget(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET, {
      wireframeOpacityPercent: 22,
    });

    expect(Object.keys(controller.getSnapshot().overrides).sort()).toEqual([
      "fdm-domain",
      "fdm-universe-outside-support",
    ]);
    expect(controller.getSettings(mainTarget).wireframeOpacityPercent).toBe(11);
    expect(
      controller.getSettings(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET)
        .wireframeOpacityPercent,
    ).toBe(22);
  });

  it("keeps an orphan part target separate from its Explorer node address", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "mesh-part",
        label: "Recovered volume",
        nodeId: "model:mesh:unassigned:part%3Aorphan",
        objectId: null,
        ref: {
          carrierPartId: "part:orphan",
          kind: "mesh-part",
          nodeId: "model:mesh:unassigned:part%3Aorphan",
          objectId: null,
          type: "mesh-part",
          visualizationTargetId: "part:orphan",
        },
      }),
    ).toEqual({
      id: "part:orphan",
      kind: "part",
      label: "Recovered volume",
    });
  });

  it("resolves visualization Debug selections without changing canonical targets", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.visualization.debug",
        label: "Debug",
        nodeId: "model:airbox:visualization:debug",
        objectId: null,
        ref: {
          kind: "airbox.visualization.debug",
          nodeId: "model:airbox:visualization:debug",
          type: "airbox",
          visualizationTargetId: "airbox",
        },
      }),
    ).toEqual(AIRBOX_VISUALIZATION_TARGET);

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.visualization.debug",
        label: "Debug",
        nodeId: "model:object:free-layer_geom:visualization:debug",
        objectId: "free-layer_geom",
        ref: {
          kind: "object.visualization.debug",
          nodeId: "model:object:free-layer_geom:visualization:debug",
          objectId: "free-layer_geom",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      }),
    ).toEqual({ id: "object:free-layer", kind: "object", label: "Debug" });

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.region.visualization.debug",
        label: "Debug",
        nodeId: "model:object:free-layer:regions:core:visualization:debug",
        objectId: "free-layer",
        ref: {
          kind: "object.region.visualization.debug",
          nodeId: "model:object:free-layer:regions:core:visualization:debug",
          objectId: "free-layer",
          regionId: "core/shell:top",
          type: "scene-object",
          visualizationTargetId: "region:free-layer:core%2Fshell%3Atop",
        },
      }),
    ).toEqual({
      id: "region:free-layer:core%2Fshell%3Atop",
      kind: "region",
      label: "Debug",
    });
  });

  it("resolves the multilayer Airbox target selection to the canonical Airbox target", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.multilayer.target",
        label: "Multilayer H_demag target",
        nodeId: "model:airbox:multilayer-target",
        objectId: null,
        ref: {
          kind: "airbox.multilayer.target",
          nodeId: "model:airbox:multilayer-target",
          type: "airbox",
          visualizationTargetId: "airbox",
        },
      }),
    ).toEqual(AIRBOX_VISUALIZATION_TARGET);

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.multilayer.target",
        label: "Multilayer H_demag target",
        nodeId: "model:airbox:multilayer-target",
        objectId: null,
        ref: {
          kind: "airbox.multilayer.target",
          nodeId: "model:airbox:multilayer-target",
          type: "airbox",
          visualizationTargetId: "airbox",
        },
      }),
    ).not.toEqual(FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET);

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.root",
        label: "Airbox",
        nodeId: "model:airbox",
        objectId: null,
        ref: {
          kind: "airbox.root",
          nodeId: "model:airbox",
          type: "airbox",
          visualizationTargetId: "airbox",
        },
      }),
    ).toEqual(AIRBOX_VISUALIZATION_TARGET);
  });

  it.each([
    "airbox.mesh",
    "airbox.mesh.parameters",
    "airbox.mesh.quality-gates",
    "airbox.mesh.statistics",
    "airbox.mesh.topology",
    "airbox.mesh.build",
  ] as const)(
    "does not resolve %s as a display-edit target",
    (kind) => {
      const nodeId = `model:${kind.replaceAll(".", ":")}`;
      expect(
        resolveVisualizationTargetFromSelection({
          kind,
          label: kind,
          nodeId,
          objectId: null,
          ref: {
            kind,
            nodeId,
            type: "airbox",
            visualizationTargetId: "airbox",
          },
        }),
      ).toBeNull();
    },
  );

  it("patches and clears target overrides without storing resource data", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    controller.patchTarget(target, {
      surfaceOpacityPercent: 41,
      renderMode: "wireframe",
      vectorsVisible: true,
    });

    expect(controller.getSettings(target)).toMatchObject({
      surfaceOpacityPercent: 41,
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: true,
    });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(target)])
      .toMatchObject({
        surfaceOpacityPercent: 41,
        pointsVisible: false,
        shaderVisible: false,
        wireframeVisible: true,
      });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(target)])
      .not.toHaveProperty("renderMode");

    controller.clearTarget(target);

    expect(controller.getSettings(target)).toMatchObject({
      surfaceOpacityPercent: 100,
      renderMode: "surface",
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
    controller.patchTarget(regionTarget, { surfaceOpacityPercent: 35 });

    expect(controller.getSnapshot().overrides[visualizationTargetKey(objectTarget)])
      .toMatchObject({ visible: false });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(regionTarget)])
      .toMatchObject({ surfaceOpacityPercent: 35 });
    expect(controller.getSettings(regionTarget)).toMatchObject({
      surfaceOpacityPercent: 35,
      visible: false,
    });
  });

  it("keeps only explicitly overridden region display passes independent", () => {
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
      vectorsVisible: true,
      wireframeVisible: false,
      visible: true,
    });
  });

  it("does not activate a region display pass when visible alone is enabled", () => {
    const controller = new ObjectVisualizationController();
    const target = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };

    controller.patchTarget(target, { visible: true });

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
      }).effectiveSettings,
    ).toMatchObject({
      pointsVisible: false,
      primitiveVisible: false,
      shaderVisible: false,
      vectorsVisible: false,
      visible: true,
      wireframeVisible: false,
    });
  });

  it("enables a region display pass independently when the owner is hidden", () => {
    const controller = new ObjectVisualizationController();
    const ownerTarget = { id: "object:film", kind: "object" as const };
    const regionTarget = {
      id: "region:film:film%3Acore",
      kind: "region" as const,
    };
    controller.patchTarget(ownerTarget, {
      shaderVisible: false,
      visible: false,
      wireframeVisible: false,
    });
    controller.patchTarget(regionTarget, {
      shaderVisible: true,
      visible: true,
    });

    const ownerSettings = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target: ownerTarget,
    }).settings;
    expect(
      resolveTargetVisualization({
        inheritedSettings: ownerSettings,
        snapshot: controller.getSnapshot(),
        target: regionTarget,
      }).effectiveSettings,
    ).toMatchObject({
      shaderVisible: true,
      visible: true,
      wireframeVisible: false,
    });
  });

  it("keeps the external-store snapshot reference stable between changes", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    const initial = controller.getSnapshot();

    expect(controller.getSnapshot()).toBe(initial);

    controller.patchTarget(target, {
      surfaceOpacityPercent: 41,
      renderMode: "wireframe",
    });

    const patched = controller.getSnapshot();
    expect(patched).not.toBe(initial);
    expect(controller.getSnapshot()).toBe(patched);

    controller.patchTarget(target, {
      surfaceOpacityPercent: 41,
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
      surfaceOpacityPercent: 35,
      wireframeVisible: true,
    });

    expect(
      resolveVisualizationSettings(controller.getSnapshot(), target, {
        ...DEFAULT_OBJECT_VISUALIZATION,
        boundsVisible: false,
        geometryScope: "full",
        surfaceOpacityPercent: 80,
        pointsVisible: true,
        renderMode: "points",
        shaderVisible: false,
        vectorsVisible: true,
        visible: true,
        wireframeVisible: false,
      }),
    ).toMatchObject({
      surfaceOpacityPercent: 35,
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

  it("does not seed the FDM domain from global FEM visualization state", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "fdm-domain", kind: "fdm-domain" as const };
    const visualizationState = {
      active_quantity_id: "H_eff",
      colormap: "inferno",
      layers: {
        bounds: { opacity: 0.25, visible: true },
        points: { opacity: 0.35, visible: true },
        surface: { opacity: 0.45, visible: false },
        vectors: { density: 17, visible: true },
        wireframe: { visible: true },
      },
      revision: 19,
      vector_glyphs: true,
      vector_style: {
        color_mode: "x",
        length_scale: 2.5,
        thickness: 3,
      },
    };

    controller.patchDefaults("fdm-domain", { surfaceOpacityPercent: 64 });
    controller.patchTarget(target, { activeQuantityId: "H_demag" });
    controller.patchViewportPreferences(target, { vectorCenteringEnabled: false });

    const resolved = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target,
      visualizationState: visualizationState as never,
    });

    expect(resolved.baseSettings).toEqual(DEFAULT_FDM_DOMAIN_VISUALIZATION);
    expect(resolved.settings).toMatchObject({
      activeQuantityId: "H_demag",
      boundsVisible: false,
      pointsVisible: false,
      scalarColorPalette: "viridis",
      shaderVisible: false,
      surfaceOpacityPercent: 64,
      vectorBudget: 1200,
      vectorCenteringEnabled: false,
      vectorColorMode: "orientation",
      vectorsVisible: false,
      wireframeVisible: true,
    });
  });

  it("uses the effective object registry settings instead of global visualization defaults", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    const resolved = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target,
      visualizationState: {
        revision: 14,
        overrides: [
          {
            scope: "object",
            scope_id: "free-layer",
            style: { surface_projection_mode: "raw_nodal" },
          },
        ],
        targets: {
          airbox: {} as never,
          objects: [
            {
                label: "Free layer",
                scope: "object",
                scope_id: "free-layer",
                settings: {
                  active_quantity_id: "m",
                  bounds_visible: false,
                  geometry_scope: "surface",
                  opacity: 1,
                  point_color: "#ffffff",
                  points_visible: false,
                  render_mode: "surface",
                  scalar_color_palette: "viridis",
                  surface_color_source: "orientation",
                  surface_mono_color: "#ffffff",
                  surface_projection_mode: "thickness_average_z",
                  surface_visible: true,
                  vector_alpha: 1,
                  vector_budget: 1200,
                  vector_color_mode: "orientation",
                  vector_length_scale: 1,
                  vector_mono_color: "#ffffff",
                  vector_thickness: 1,
                  vectors_visible: false,
                  viewport_colorbar_visible: false,
                  visible: true,
                  wireframe_color: "#ffffff",
                  wireframe_opacity: 1,
                  wireframe_visible: false,
                },
                source: "scene_object",
            },
          ],
          parts: [],
        },
      } as never,
    });

    expect(resolved.effectiveSettings).toMatchObject({
      surfaceProjectionMode: "thickness_average_z",
      wireframeVisible: false,
    });
    expect(resolved.override).toMatchObject({
      surfaceProjectionMode: "raw_nodal",
    });
  });

  it("uses the effective mesh-part registry settings instead of object defaults", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "part:part-film", kind: "part" as const };

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: {
          revision: 15,
          targets: {
            airbox: {} as never,
            objects: [],
            parts: [
              {
                label: "Film mesh part",
                scope: "part",
                scope_id: "part-film",
                settings: {
                  active_quantity_id: "m",
                  bounds_visible: false,
                  geometry_scope: "surface",
                  opacity: 1,
                  point_color: "#ffffff",
                  points_visible: false,
                  render_mode: "wireframe",
                  scalar_color_palette: "viridis",
                  surface_color_source: "orientation",
                  surface_mono_color: "#ffffff",
                  surface_projection_mode: "raw_nodal",
                  surface_visible: false,
                  vector_alpha: 1,
                  vector_budget: 1200,
                  vector_color_mode: "orientation",
                  vector_length_scale: 1,
                  vector_mono_color: "#ffffff",
                  vector_thickness: 1,
                  vectors_visible: false,
                  viewport_colorbar_visible: false,
                  visible: true,
                  wireframe_color: "#ffffff",
                  wireframe_opacity: 1,
                  wireframe_visible: true,
                },
                source: "mesh_part",
              },
            ],
          },
        } as never,
      }).effectiveSettings,
    ).toMatchObject({
      shaderVisible: false,
      wireframeVisible: true,
    });

  });

  it("preserves viewport colorbar visibility from the effective target registry", () => {
    const controller = new ObjectVisualizationController();

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target: { id: "object:film", kind: "object" },
        visualizationState: {
          revision: 4,
          targets: {
            airbox: {} as never,
            objects: [
              {
                scope: "object",
                scope_id: "film",
                settings: {
                  viewport_colorbar_visible: true,
                } as never,
              },
            ],
            parts: [],
          },
        } as never,
      }).effectiveSettings.viewportColorbarVisible,
    ).toBe(true);
  });

  it("serializes a canonical part target back to the exact mesh carrier scope id", () => {
    expect(
      visualizationStateOverrideFromTargetPatch(
        { id: "part:part-film", kind: "part" },
        { visible: true },
      ),
    ).toMatchObject({
      scope: "part",
      scope_id: "part-film",
      visible: true,
    });
  });

  it("keeps a pending target patch until the backend response contains that target override", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    controller.patchDefaults("object", {
      surfaceProjectionMode: "raw_nodal",
      wireframeVisible: false,
    });
    controller.patchTarget(target, { wireframeVisible: false });
    controller.patchTargetPending(target, { shaderVisible: false }, 14);

    const stateAtPendingRevision = {
      revision: 14,
      targets: {
        airbox: {} as never,
        objects: [
          {
            scope: "object",
            scope_id: "free-layer",
            settings: {
              surface_projection_mode: "thickness_average_z",
              surface_visible: true,
              wireframe_visible: true,
            } as never,
          },
        ],
        parts: [],
      },
    };

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: stateAtPendingRevision as never,
      }).settings,
    ).toMatchObject({
      shaderVisible: false,
      surfaceProjectionMode: "thickness_average_z",
      wireframeVisible: true,
    });

    const unrelatedNewerState = {
      ...stateAtPendingRevision,
      revision: 15,
    };
    controller.acknowledgePendingTargetPatches(unrelatedNewerState as never);
    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: unrelatedNewerState as never,
      }).settings,
    ).toMatchObject({
      shaderVisible: false,
      surfaceProjectionMode: "thickness_average_z",
      wireframeVisible: true,
    });
    expect(controller.getSnapshot().pendingOverrides).not.toEqual({});

    controller.acknowledgePendingTargetPatches({
      ...unrelatedNewerState,
      overrides: [
        {
          scope: "object",
          scope_id: "free-layer",
          display: { surface: { visible: false } },
        },
      ],
    } as never);
    expect(controller.getSnapshot().pendingOverrides).toEqual({});
  });

  it("applies a pending FEM target patch before a backend target registry exists", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "object:fem-owned", kind: "object" as const };

    controller.patchTargetPending(
      target,
      { shaderVisible: false, wireframeVisible: true },
      14,
    );

    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: {
          revision: 14,
          layers: {
            surface: { visible: true },
            wireframe: { visible: false },
          },
          overrides: [],
        } as never,
      }).settings,
    ).toMatchObject({
      shaderVisible: false,
      wireframeVisible: true,
    });
  });

  it("keeps client-only target rendering preferences outside pending registry patches", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    controller.patchViewportPreferences(target, {
      primitiveVisible: true,
      vectorCenteringEnabled: false,
    });

    const resolved = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target,
      visualizationState: {
        revision: 20,
        targets: {
          airbox: {} as never,
          objects: [
            {
              scope: "object",
              scope_id: "free-layer",
              settings: {
                surface_projection_mode: "thickness_average_z",
                surface_visible: true,
              } as never,
            },
          ],
          parts: [],
        },
      } as never,
    });

    expect(resolved.settings).toMatchObject({
      primitiveVisible: true,
      surfaceProjectionMode: "thickness_average_z",
      shaderVisible: true,
      vectorCenteringEnabled: false,
    });
    expect(controller.getSnapshot().pendingOverrides).toEqual({});
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
                bounds: { opacity: 0.2, visible: true },
                geometry_scope: "surface",
                opacity: 0.35,
                points: { opacity: 0.7, visible: true },
                surface: { opacity: 0.3, visible: false },
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
        boundsOpacityPercent: 20,
        boundsVisible: true,
        geometryScope: "surface",
        pointOpacityPercent: 70,
        pointsVisible: true,
        surfaceOpacityPercent: 30,
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
      surfaceOpacityPercent: 35,
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
        surface: { opacity: 0.35 },
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

  it("serializes surface, wireframe, and vector opacity independently", () => {
    const target = { id: "free-layer", kind: "object" as const };

    expect(
      visualizationStateOverrideFromTargetPatch(target, {
        surfaceOpacityPercent: 35,
      }),
    ).toEqual({
      display: { surface: { opacity: 0.35 } },
      scope: "object",
      scope_id: "free-layer",
    });
    expect(
      visualizationStateOverrideFromTargetPatch(target, {
        wireframeOpacityPercent: 45,
      }),
    ).toEqual({
      display: { wireframe: { opacity: 0.45 } },
      scope: "object",
      scope_id: "free-layer",
    });
    expect(
      visualizationStateOverrideFromTargetPatch(target, {
        vectorAlphaPercent: 55,
      }),
    ).toEqual({
      scope: "object",
      scope_id: "free-layer",
      style: { vector_alpha: 0.55 },
    });
  });

  it("keeps the viewport-local FDM domain out of FEM visualization overrides", () => {
    const target = { id: "fdm-domain", kind: "fdm-domain" as const };
    const existing = [
      {
        scope: "object" as const,
        scope_id: "film",
        visible: true,
      },
    ];

    expect(
      visualizationStateOverrideFromTargetPatch(target, { visible: false }),
    ).toBeNull();
    expect(
      mergeVisualizationStateTargetOverride(existing, target, {
        visible: false,
      }),
    ).toEqual(existing);
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
    ).toMatchObject({
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

  it("removes an inherited surface color override and prunes the empty target entry", () => {
    expect(
      removeTargetOverrideField(
        [
          {
            scope: "region",
            scope_id: "region:free-layer:core",
            style: { surface_color_source: "component_x" },
          },
        ],
        { id: "region:free-layer:core", kind: "region" },
        "surfaceColorSource",
      ),
    ).toEqual([]);
  });

  it("removes surface opacity without removing surface visibility", () => {
    expect(
      removeTargetOverrideField(
        [
          {
            scope: "object",
            scope_id: "free-layer",
            display: {
              opacity: 0.2,
              surface: { opacity: 0.35, visible: true },
              wireframe: { opacity: 0.45, visible: true },
            },
            style: { vector_alpha: 0.55 },
          },
        ],
        { id: "free-layer", kind: "object" },
        "surfaceOpacityPercent",
      ),
    ).toEqual([
      {
        scope: "object",
        scope_id: "free-layer",
        display: {
          surface: { visible: true },
          wireframe: { opacity: 0.45, visible: true },
        },
        style: { vector_alpha: 0.55 },
      },
    ]);
  });

  it("returns to the owner style after inherited deletion and a resource reload", () => {
    const target = { id: "region:free-layer:core", kind: "region" as const };
    const overrides = removeTargetOverrideField(
      [
        {
          scope: "region",
          scope_id: target.id,
          style: { surface_color_source: "component_x" },
        },
      ],
      target,
      "surfaceColorSource",
    );

    expect(
      resolveTargetVisualization({
        inheritedSettings: {
          ...DEFAULT_OBJECT_VISUALIZATION,
          surfaceColorSource: "orientation",
        },
        snapshot: new ObjectVisualizationController().getSnapshot(),
        target,
        visualizationState: { overrides } as never,
      }).settings.surfaceColorSource,
    ).toBe("orientation");
  });

  it("removes only the inherited local field without clearing local render preferences", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "object:free-layer", kind: "object" as const };
    controller.patchTarget(target, { surfaceColorSource: "component_x" });
    controller.patchViewportPreferences(target, { primitiveVisible: true });

    controller.removeTargetOverrideField(target, "surfaceColorSource");

    expect(controller.getSnapshot().overrides).not.toHaveProperty("object:free-layer");
    expect(controller.getSnapshot().viewportPreferences).toMatchObject({
      "object:free-layer": { primitiveVisible: true },
    });
  });

  it("removes only the inherited field and preserves other serialized override fields", () => {
    expect(
      removeTargetOverrideField(
        [
          {
            scope: "object",
            scope_id: "free-layer",
            display: { wireframe: { visible: false } },
            style: {
              surface_color_source: "component_x",
              surface_mono_color: "#ffffff",
            },
          },
        ],
        { id: "object:free-layer", kind: "object" },
        "shaderColorMode",
      ),
    ).toEqual([
      {
        scope: "object",
        scope_id: "free-layer",
        display: { wireframe: { visible: false } },
        style: { surface_mono_color: "#ffffff" },
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
          surface: { opacity: 0.31, visible: false },
            vectors: { density: 64, domain: "airbox_only", visible: true },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
      }),
    ).toMatchObject({
      surfaceOpacityPercent: 31,
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
              bounds_opacity: 1,
              bounds_visible: false,
              geometry_scope: "full",
              opacity: 0.28,
              point_color: "var(--fm-info)",
              point_opacity: 1,
              points_visible: false,
              render_mode: "surface",
              scalar_color_palette: "viridis",
              surface_color_source: "solid",
              surface_projection_mode: "raw_nodal",
              surface_mono_color: "var(--fm-airbox-fill)",
              surface_opacity: 0.28,
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
            surface: { opacity: 0.31, visible: false },
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
              bounds_opacity: 1,
              bounds_visible: true,
              geometry_scope: "surface",
              opacity: 0.28,
              point_opacity: 1,
              points_visible: false,
              render_mode: "wireframe",
              scalar_color_palette: "inferno",
              surface_color_source: "solid",
              surface_projection_mode: "raw_nodal",
              surface_mono_color: "#112233",
              surface_opacity: 0.28,
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
      surfaceOpacityPercent: 31,
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

  it("keeps airbox quantity target patches remotely addressable", () => {
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        activeQuantityId: "h_eff",
      }),
    ).toEqual({});

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
              bounds_opacity: 1,
              bounds_visible: false,
              geometry_scope: "full",
              opacity: 0.28,
              point_color: "var(--fm-info)",
              point_opacity: 1,
              points_visible: false,
              render_mode: "surface",
              scalar_color_palette: "viridis",
              surface_color_source: "solid",
              surface_projection_mode: "raw_nodal",
              surface_mono_color: "var(--fm-airbox-fill)",
              surface_opacity: 0.28,
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
          visible: true,
        },
      },
      overrides: [
        {
          display: {
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
      shaderVisible: false,
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
        surfaceOpacityPercent: 25,
        shaderVisible: true,
        vectorBudget: 64,
        vectorsVisible: true,
        visible: false,
        wireframeVisible: false,
      }),
    ).toMatchObject({
      layers: {
        airbox: {
          bounds: { visible: true },
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
          display: {
            vectors: { visible: true },
          },
          scope: "airbox",
          scope_id: "airbox",
          style: {
            vector_budget: 64,
            vector_length_scale: 2.25,
            vector_thickness: 1.5,
          },
        },
      ],
    });
  });

  it("changes only the airbox master gate when visibility is turned on", () => {
    const patch = airboxVisualizationStatePatchFromTargetPatch({ visible: true });

    expect(patch.layers?.airbox).toEqual({ visible: true });
    expect(JSON.stringify(patch)).not.toContain('"surface"');
  });

  it("turns off Airbox geometry without changing its master visibility or vectors", () => {
    const patch = airboxVisualizationStatePatchFromTargetPatch(
      renderModePatch("off"),
    );

    expect(patch.layers?.airbox).toMatchObject({
      wireframe: { visible: false },
    });
    expect(patch.layers?.airbox).not.toHaveProperty("visible");
    expect(patch.layers?.airbox).not.toHaveProperty("vectors");
  });

  it("drops a shader request when an Airbox visibility patch includes it", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        shaderVisible: true,
        visible: true,
      }),
    ).toMatchObject({
      layers: {
        airbox: {
          visible: true,
        },
      },
    });
  });

  it("keeps only renderer-local airbox fields out of backend state patches", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        geometryScope: "full",
      }),
    ).toMatchObject({
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          display: { geometry_scope: "full" },
        },
      ],
    });
    expect(
      airboxLocalVisualizationPatchFromTargetPatch({
        boundsVisible: true,
        geometryScope: "full",
        vectorBudget: 64,
        vectorLengthScale: 2,
        visible: false,
        wireframeVisible: false,
      }),
    ).toEqual({});
  });

  it("owns renderer-only controls in viewport preferences without serializing them as target overrides", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "object:free-layer", kind: "object" as const };

    controller.patchViewportPreferences(target, {
      primitiveVisible: true,
      vectorCenteringEnabled: false,
      vectorSurfaceOffsetEnabled: true,
      vectorSurfaceOffsetScale: 0.3,
    });

    expect(controller.getSnapshot()).toMatchObject({
      overrides: {},
      viewportPreferences: {
        "object:free-layer": {
          primitiveVisible: true,
          vectorCenteringEnabled: false,
          vectorSurfaceOffsetEnabled: true,
          vectorSurfaceOffsetScale: 0.3,
        },
      },
    });
    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
      }).settings,
    ).toMatchObject({
      primitiveVisible: true,
      vectorCenteringEnabled: false,
      vectorSurfaceOffsetEnabled: true,
      vectorSurfaceOffsetScale: 0.3,
    });
  });

  it("does not carry viewport preferences across controller reloads or clients while server settings remain shared", () => {
    const target = { id: "object:free-layer", kind: "object" as const };
    const firstViewport = new ObjectVisualizationController();
    const secondViewport = new ObjectVisualizationController();
    const serverState = {
      revision: 7,
      overrides: [
        {
          scope: "object",
          scope_id: "object:free-layer",
          display: { visible: false },
        },
      ],
    } as never;

    firstViewport.patchViewportPreferences(target, {
      primitiveVisible: true,
      vectorCenteringEnabled: false,
    });

    expect(
      resolveTargetVisualization({
        snapshot: firstViewport.getSnapshot(),
        target,
        visualizationState: serverState,
      }).settings,
    ).toMatchObject({ primitiveVisible: true, vectorCenteringEnabled: false, visible: false });
    expect(
      resolveTargetVisualization({
        snapshot: secondViewport.getSnapshot(),
        target,
        visualizationState: serverState,
      }).settings,
    ).toMatchObject({ primitiveVisible: false, vectorCenteringEnabled: true, visible: false });
  });

  it("builds backend global visualization state patches from default target patches", () => {
    expect(
      visualizationStatePatchFromDefaultTargetPatch({
        boundsVisible: true,
        surfaceOpacityPercent: 42,
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
