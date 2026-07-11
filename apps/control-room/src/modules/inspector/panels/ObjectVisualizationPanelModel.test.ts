import { describe, expect, it } from "vitest";

import type {
  FieldCatalogResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import {
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
  resolveEffectiveVisualizationSettings,
  resolveTargetVisualization,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  buildAirboxVectorDiagnostic,
  queuePartVectorVisibilityPatch,
  queueTargetVectorVisibilityPatch,
  buildAirboxVisibilityDiagnostic,
  buildVisualizationVectorBudgetDiagnostic,
  buildVisualizationPanelSections,
  colorPickerInputValue,
  displayPassTogglePatch,
  fieldMetaScopeQueryForVisualizationTarget,
  formatScalarColorbarValueWithUnit,
  formatScalarColorbarValueWithDisplayUnit,
  geometryScopeDisplayPatch,
  geometryScopeVectorBudgetPatch,
  quantitySourcePatch,
  resolveObjectVisualizationPanelTarget,
  resolveSelectedTargetVectorMeshPartRows,
  resolveSelectedTargetVectorMeshParts,
  visualizationVectorSurfaceActionTargetLabel,
  resolveObjectVisualizationPanelSelectionTarget,
  resolveSurfaceColorSourceItems,
  resolveObjectVisualizationPanelTopologyFreshness,
  resolveObjectChildRegionVisualizationTargets,
  resolveRegionVisualizationCarrier,
  scalarColorPalettePatch,
  resolveVisualizationVectorBudgetRange,
  shouldShowPrimitiveDisplayToggle,
  shouldLoadObjectVisualizationFieldCatalog,
  shouldShowSurfaceFieldColorbar,
  surfaceFieldProjectionModePatch,
  SURFACE_COLOR_SOURCE_ITEMS,
  SURFACE_FIELD_PROJECTION_ITEMS,
  surfaceColorSourceFieldMetaComponent,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  renderModeDisplayPatch,
  regionVisualizationCarrierSupportsFieldMeta,
  regionVisualizationFieldWarning,
  VISUALIZATION_COLOR_MODE_ITEMS,
  VISUALIZATION_QUANTITY_ITEMS,
  visualizationOverrideStateLabel,
  visualizationQuantityItems,
  visualizationResetActionLabel,
} from "./ObjectVisualizationPanelModel";

type MeshPart = NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];

describe("ObjectVisualizationPanelModel", () => {
  it.each([
    [{ id: "region:object-a:shell", kind: "region" } as const, "Target: region:object-a:shell"],
    [{ id: "airbox", kind: "airbox" } as const, "Target: airbox"],
  ])("labels every scoped surface row with its canonical action target", (target, label) => {
    expect(visualizationVectorSurfaceActionTargetLabel(target)).toBe(label);
  });

  it("limits object surface rows to the selected object target", () => {
    const meshParts = [
      { id: "part-a", label: "Object A", object_id: "object-a", role: "magnetic" },
      { id: "part-b", label: "Object B", object_id: "object-b", role: "magnetic" },
    ] as MeshPart[];

    expect(
      resolveSelectedTargetVectorMeshParts({
        meshParts,
        manifestRegions: [],
        sceneObjectIds: new Set(["object-a", "object-b"]),
        target: { id: "object:object-a", kind: "object" },
        visualizationState: null,
      }).map((part) => part.id),
    ).toEqual(["part-a"]);
  });

  it("uses only manifest region mesh-part carriers for a selected region", () => {
    const meshParts = [
      { id: "part-region", label: "Region", object_id: "object-a", role: "magnetic" },
      { id: "part-other", label: "Other", object_id: "object-a", role: "magnetic" },
    ] as MeshPart[];

    expect(
      resolveSelectedTargetVectorMeshParts({
        meshParts,
        manifestRegions: [
          {
            mesh_part_ids: ["part-region"],
            source_object_ids: ["object-a"],
            source_region_candidate_id: "shell",
          },
        ] as never,
        sceneObjectIds: new Set(["object-a"]),
        target: { id: "region:object-a:shell", kind: "region" },
        visualizationState: null,
      }).map((part) => part.id),
    ).toEqual(["part-region"]);
  });

  it("uses only air carriers for a selected airbox", () => {
    const meshParts = [
      { id: "part-air", label: "Air", role: "air" },
      { id: "part-a", label: "Object A", object_id: "object-a", role: "magnetic" },
    ] as MeshPart[];

    expect(
      resolveSelectedTargetVectorMeshParts({
        meshParts,
        manifestRegions: [],
        sceneObjectIds: new Set(["object-a"]),
        target: { id: "airbox", kind: "airbox" },
        visualizationState: null,
      }).map((part) => part.id),
    ).toEqual(["part-air"]);
  });

  it("labels every multi-carrier region and airbox row with its selected target", () => {
    const regionRows = resolveSelectedTargetVectorMeshPartRows({
      meshParts: [
        { id: "part-region-a", label: "Region A", object_id: "object-a", role: "magnetic" },
        { id: "part-region-b", label: "Region B", object_id: "object-a", role: "magnetic" },
      ] as MeshPart[],
      manifestRegions: [{ mesh_part_ids: ["part-region-a", "part-region-b"], source_object_ids: ["object-a"], source_region_candidate_id: "shell" }] as never,
      sceneObjectIds: new Set(["object-a"]),
      target: { id: "region:object-a:shell", kind: "region" },
      visualizationState: null,
    });
    const airboxRows = resolveSelectedTargetVectorMeshPartRows({
      meshParts: [
        { id: "part-air-a", label: "Air A", role: "air" },
        { id: "part-air-b", label: "Air B", role: "airbox" },
      ] as MeshPart[],
      manifestRegions: [],
      sceneObjectIds: new Set(),
      target: { id: "airbox", kind: "airbox" },
      visualizationState: null,
    });

    expect(regionRows.map((row) => row.actionTargetLabel)).toEqual([
      "Target: region:object-a:shell",
      "Target: region:object-a:shell",
    ]);
    expect(airboxRows.map((row) => row.actionTargetLabel)).toEqual([
      "Target: airbox",
      "Target: airbox",
    ]);
  });

  it("patches the selected region target instead of a listed mesh-part carrier", () => {
    const queuedPatches: unknown[] = [];
    const controller = new ObjectVisualizationController();
    const state = { revision: 7, overrides: [], targets: { airbox: {}, objects: [], parts: [] } } as never;
    const target = { id: "region:object-a:shell", kind: "region" } as const;

    expect(
      queueTargetVectorVisibilityPatch({
        controller,
        state,
        sync: { queuePatch: (patch) => queuedPatches.push(patch) },
        target,
        visible: false,
      }),
    ).toEqual(target);
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: false } },
            scope: "region",
            scope_id: "region:object-a:shell",
          },
        ],
      },
    ]);
  });

  it.each([
    { scopeId: "object-a", target: { id: "object:object-a", kind: "object" } as const },
    { scopeId: "region:object-a:shell", target: { id: "region:object-a:shell", kind: "region" } as const },
    { scopeId: "airbox", target: { id: "airbox", kind: "airbox" } as const },
  ])("keeps vector actions on the selected $target.kind target", ({ scopeId, target }) => {
    const queuedPatches: unknown[] = [];
    const controller = new ObjectVisualizationController();
    const state = { revision: 7, overrides: [], targets: { airbox: {}, objects: [], parts: [] } } as never;

    expect(
      queueTargetVectorVisibilityPatch({
        controller,
        state,
        sync: { queuePatch: (patch) => queuedPatches.push(patch) },
        target,
        visible: false,
      }),
    ).toEqual(target);
    expect(queuedPatches[0]).toMatchObject({
      overrides: [
        expect.objectContaining({
          scope: target.kind,
          scope_id: scopeId,
        }),
      ],
    });
  });
  it("exposes the surface color source options used by Surface Coloring", () => {
    expect(SURFACE_COLOR_SOURCE_ITEMS.map((item) => item.value)).toEqual([
      "solid",
      "orientation",
      "component_x",
      "component_y",
      "component_z",
      "magnitude",
      "colormap",
    ]);
  });

  it("exposes the surface field projection options used by Surface Coloring", () => {
    expect(SURFACE_FIELD_PROJECTION_ITEMS.map((item) => item.value)).toEqual([
      "raw_nodal",
      "surface_faces",
      "thickness_average_z",
    ]);
    expect(surfaceFieldProjectionModePatch("surface_faces")).toEqual({
      surfaceProjectionMode: "surface_faces",
    });
    expect(surfaceFieldProjectionModePatch("unknown")).toEqual({
      surfaceProjectionMode: "raw_nodal",
    });
  });

  it("exposes the production color mode options used by Global Display", () => {
    expect(VISUALIZATION_COLOR_MODE_ITEMS.map((item) => item.value)).toEqual([
      "orientation",
      "x",
      "y",
      "z",
      "magnitude",
      "monochrome",
    ]);
  });

  it("resolves object child region visualization targets from scene and manifest data", () => {
    expect(
      resolveObjectChildRegionVisualizationTargets({
        manifestRegions: [
          {
            mesh_part_ids: ["part:film:shell"],
            name: "Shell",
            source_object_ids: ["film_geom"],
            source_region_candidate_id: "film:shell",
          },
          {
            mesh_part_ids: ["part:other:core"],
            name: "Other",
            source_object_ids: ["other"],
            source_region_candidate_id: "other:core",
          },
        ] as never,
        objectId: "film",
        scene: {
          objects: [
            {
              id: "film",
              regions: [
                { name: "Core", region_id: "film:core" },
                { id: "film:shell", name: "Shell duplicate" },
              ],
            },
          ],
        },
      }).map((target) => [target.id, target.label]),
    ).toEqual([
      ["region:film:film%3Acore", "Core"],
      ["region:film:film%3Ashell", "Shell duplicate"],
    ]);
  });

  it("does not expose duplicate orientation aliases as inspector option values", () => {
    const surfaceValues: string[] = SURFACE_COLOR_SOURCE_ITEMS.map(
      (item) => item.value,
    );
    const vectorValues: string[] = VISUALIZATION_COLOR_MODE_ITEMS.map(
      (item) => item.value,
    );

    expect(surfaceValues).not.toContain("hsl_orientation");
    expect(vectorValues).not.toContain("hsl_orientation");
    expect(new Set(surfaceValues).size).toBe(surfaceValues.length);
    expect(new Set(vectorValues).size).toBe(vectorValues.length);
  });

  it("exposes target quantity options for the inspector visualization panel", () => {
    expect(VISUALIZATION_QUANTITY_ITEMS.map((item) => item.value)).toEqual([
      "m",
      "H_eff",
      "H_demag",
      "H_ex",
      "H_ani",
      "torque",
      "eden_total",
      "eden_ex",
      "eden_demag",
      "eden_ext",
      "eden_ani",
      "eden_dmi",
      "mat_ms",
      "mat_aex",
      "mat_alpha",
      "mat_dind",
      "mat_dbulk",
    ]);
    expect(visualizationQuantityItems("exchange_field")[0]).toEqual({
      label: "exchange_field",
      value: "exchange_field",
    });
  });

  it("filters out magnetization and material quantities for the airbox target kind", () => {
    const airboxItems = visualizationQuantityItems("H_demag", "airbox");
    expect(airboxItems.map((item) => item.value)).toEqual([
      "H_eff",
      "H_demag",
    ]);
  });


  it("switches scalar material quantities to colormap surface coloring", () => {
    expect(
      quantitySourcePatch(
        {
          ...DEFAULT_OBJECT_VISUALIZATION,
          surfaceColorSource: "orientation",
        },
        "material_ms",
      ),
    ).toEqual({
      activeQuantityId: "mat_ms",
      surfaceColorSource: "colormap",
    });
  });

  it("limits surface color source options to scalar colormap for scalar quantities", () => {
    expect(resolveSurfaceColorSourceItems("mat_ms").map((item) => item.value)).toEqual([
      "colormap",
    ]);
    expect(resolveSurfaceColorSourceItems("m").map((item) => item.value)).toEqual(
      SURFACE_COLOR_SOURCE_ITEMS.map((item) => item.value),
    );
  });

  it("maps data-driven surface color modes to field metadata components", () => {
    expect(surfaceColorSourceFieldMetaComponent("component_x", "m")).toBe("x");
    expect(surfaceColorSourceFieldMetaComponent("component_y", "m")).toBe("y");
    expect(surfaceColorSourceFieldMetaComponent("component_z", "m")).toBe("z");
    expect(surfaceColorSourceFieldMetaComponent("magnitude", "m")).toBe("magnitude");
    expect(surfaceColorSourceFieldMetaComponent("colormap", "m")).toBe("magnitude");
    expect(surfaceColorSourceFieldMetaComponent("colormap", "mat_ms")).toBeNull();
    expect(surfaceColorSourceFieldMetaComponent("orientation", "m")).toBeUndefined();
    expect(surfaceColorSourceFieldMetaComponent("solid", "m")).toBeUndefined();
  });

  it("formats scalar colorbar values with physical units when available", () => {
    expect(formatScalarColorbarValueWithUnit(1250, "A/m")).toBe("1250 A/m");
    expect(formatScalarColorbarValueWithUnit(2.5e-4, "J/m³")).toBe("0.00025 J/m³");
    expect(formatScalarColorbarValueWithUnit(0.25, "1")).toBe("0.25");
    expect(formatScalarColorbarValueWithUnit(0.25, "")).toBe("0.25");
  });

  it("formats A/m magnetic colorbar limits as equivalent tesla values on request", () => {
    expect(
      formatScalarColorbarValueWithDisplayUnit(1_000_000, "A/m", "T"),
    ).toBe("1.257 T");
    expect(
      formatScalarColorbarValueWithDisplayUnit(1_000_000, "A/m", "A/m"),
    ).toBe("1000000 A/m");
    expect(
      formatScalarColorbarValueWithDisplayUnit(0.25, "1", "T"),
    ).toBe("0.25");
  });

  it("shows inspector colorbars only for numeric surface color modes", () => {
    expect(shouldShowSurfaceFieldColorbar("component_x", "m")).toBe(true);
    expect(shouldShowSurfaceFieldColorbar("magnitude", "m")).toBe(true);
    expect(shouldShowSurfaceFieldColorbar("colormap", "mat_ms")).toBe(true);
    expect(
      shouldShowSurfaceFieldColorbar(
        "magnitude",
        "analysis:frequency-response:frequency-0002",
      ),
    ).toBe(false);
    expect(
      shouldShowSurfaceFieldColorbar(
        "magnitude",
        "analysis:eigen:sample-0000:mode-0002",
      ),
    ).toBe(false);
    expect(shouldShowSurfaceFieldColorbar("orientation", "m")).toBe(false);
    expect(shouldShowSurfaceFieldColorbar("solid", "m")).toBe(false);
  });

  it("maps visualization targets to scoped field metadata queries", () => {
    expect(
      fieldMetaScopeQueryForVisualizationTarget({
        id: "body",
        kind: "object",
        label: "Body",
      }),
    ).toEqual({ scope_id: "body", scope_kind: "object" });
    expect(
      fieldMetaScopeQueryForVisualizationTarget({
        id: "object:permalloy_layer",
        kind: "object",
        label: "Permalloy layer",
      }),
    ).toEqual({ scope_id: "permalloy_layer", scope_kind: "object" });
    expect(
      fieldMetaScopeQueryForVisualizationTarget({
        id: "part:body",
        kind: "part",
        label: "Body part",
      }),
    ).toEqual({ scope_id: "part:body", scope_kind: "part" });
    expect(
      fieldMetaScopeQueryForVisualizationTarget({
        id: "airbox",
        kind: "airbox",
        label: "Airbox",
      }),
    ).toEqual({ scope_id: null, scope_kind: "airbox" });
    expect(
      fieldMetaScopeQueryForVisualizationTarget({
        id: "region-a",
        kind: "region",
        label: "Region A",
      }),
    ).toEqual({ scope_id: null, scope_kind: null });
    expect(
      fieldMetaScopeQueryForVisualizationTarget(
        {
          id: "region:film:film%3Acore",
          kind: "region",
          label: "Core",
        },
        {
          kind: "mesh-parts",
          objectId: "film",
          partIds: ["part:film:core"],
          regionId: "film:core",
        },
      ),
    ).toEqual({ scope_id: "part:film:core", scope_kind: "part" });
    expect(
      fieldMetaScopeQueryForVisualizationTarget(
        {
          id: "region:film:film%3Acore",
          kind: "region",
          label: "Core",
        },
        {
          kind: "mesh-parts",
          objectId: "film",
          partIds: ["part:film:core", "part:film:shell"],
          regionId: "film:core",
        },
      ),
    ).toEqual({ scope_id: null, scope_kind: null });
  });

  it("describes region field carrier capability without confusing overlays with textures", () => {
    expect(
      regionVisualizationFieldWarning({
        kind: "mesh-parts",
        objectId: "film",
        partIds: ["part:film:core"],
        regionId: "film:core",
      }),
    ).toBeNull();
    expect(
      regionVisualizationCarrierSupportsFieldMeta({
        kind: "mesh-parts",
        objectId: "film",
        partIds: ["part:film:core"],
        regionId: "film:core",
      }),
    ).toBe(true);
    expect(
      regionVisualizationFieldWarning({
        kind: "mesh-parts",
        objectId: "film",
        partIds: ["part:film:core", "part:film:shell"],
        regionId: "film:core",
      }),
    ).toContain("Scoped colorbar statistics");
    expect(
      regionVisualizationCarrierSupportsFieldMeta({
        kind: "mesh-parts",
        objectId: "film",
        partIds: ["part:film:core", "part:film:shell"],
        regionId: "film:core",
      }),
    ).toBe(false);
    expect(
      regionVisualizationFieldWarning({
        kind: "membership",
        objectId: "film",
        regionId: "film:shell",
        syntheticPartId: "membership:film%3Ashell",
      }),
    ).toContain("diagnostic");
    expect(
      regionVisualizationFieldWarning({
        kind: "unavailable",
        reason: "No mesh manifest regions are available.",
      }),
    ).toContain("Physical field coloring");
  });

  it("labels region override state as inherited until a local override exists", () => {
    expect(
      visualizationOverrideStateLabel({
        hasOverride: false,
        targetKind: "region",
      }),
    ).toBe("Inherited from parent");
    expect(
      visualizationOverrideStateLabel({
        hasOverride: true,
        targetKind: "region",
      }),
    ).toBe("Overridden locally");
    expect(visualizationResetActionLabel("region")).toBe("Reset to parent");
    expect(visualizationResetActionLabel("object")).toBe("Reset display");
  });

  it("keeps geometry-only parts scoped to the backend registry target", () => {
    expect(
      resolveObjectVisualizationPanelTarget({
        part: {
          geometry_id: "projection-film",
          id: "part-film",
          object_id: null,
        } as MeshPart,
        sceneObjectIds: new Set(),
        visualizationState: {
          targets: {
            airbox: {},
            objects: [],
            parts: [{ scope: "part", scope_id: "part-film" }],
          },
        } as never,
      }),
    ).toMatchObject({ id: "part-film", kind: "part" });
  });

  it("keeps a selected mesh part scoped to the part while its manifest is unavailable", () => {
    expect(
      resolveObjectVisualizationPanelSelectionTarget({
        selectedMeshPart: null,
        selection: {
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
        } as never,
        selectionTarget: { id: "object:projection-film", kind: "object" },
        sceneObjectIds: new Set(),
        visualizationState: null,
      }),
    ).toMatchObject({ id: "part-film", kind: "part" });
  });

  it("maps a selected degraded object-segment carrier back to its object target", () => {
    expect(
      resolveObjectVisualizationPanelSelectionTarget({
        selectedMeshPart: {
          carrierKind: "object-segment",
          fieldCapable: false,
          id: "segment:projection-film:0",
          label: "projection-film",
          object_id: "projection-film",
          role: "magnetic",
        } as never,
        selection: {
          kind: "mesh-part",
          label: "Projection film fallback",
          nodeId: "segment:projection-film:0",
          objectId: "projection-film",
          ref: {
            kind: "mesh-part",
            nodeId: "segment:projection-film:0",
            objectId: "projection-film",
            type: "mesh-part",
          },
        } as never,
        selectionTarget: { id: "segment:projection-film:0", kind: "part" },
        sceneObjectIds: new Set(["projection-film"]),
        visualizationState: null,
      }),
    ).toMatchObject({ id: "object:projection-film", kind: "object" });
  });

  it("applies a part-vector patch immediately until a newer registry revision acknowledges it", () => {
    const controller = new ObjectVisualizationController();
    const queuedPatches: unknown[] = [];
    const state = {
      revision: 7,
      overrides: [],
      targets: {
        airbox: {},
        objects: [],
        parts: [
          {
            scope: "part",
            scope_id: "part-film",
            settings: { vectors_visible: true },
          },
        ],
      },
    } as never;

    const target = queuePartVectorVisibilityPatch({
      controller,
      part: { id: "part-film", object_id: "projection-film" } as MeshPart,
      sceneObjectIds: new Set(["projection-film"]),
      state,
      sync: { queuePatch: (patch) => queuedPatches.push(patch) },
      visible: false,
    });

    expect(target).toMatchObject({ id: "part-film", kind: "part" });
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: false } },
            scope: "part",
            scope_id: "part-film",
          },
        ],
      },
    ]);
    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: state,
      }).settings.vectorsVisible,
    ).toBe(false);

    controller.acknowledgePendingTargetPatches(8);
    expect(
      resolveTargetVisualization({
        snapshot: controller.getSnapshot(),
        target,
        visualizationState: state,
      }).settings.vectorsVisible,
    ).toBe(true);
  });

  it("builds scalar palette patches for the visualization quantity colormap", () => {
    expect(scalarColorPalettePatch("inferno")).toEqual({
      scalarColorPalette: "inferno",
    });
    expect(scalarColorPalettePatch("unknown")).toEqual({
      scalarColorPalette: "viridis",
    });
  });

  it("clears stale scalar colormap mode when switching back to vector quantities", () => {
    expect(
      quantitySourcePatch(
        {
          ...DEFAULT_OBJECT_VISUALIZATION,
          surfaceColorSource: "colormap",
          vectorColorMode: "orientation",
        },
        "H_eff",
      ),
    ).toEqual({
      activeQuantityId: "H_eff",
      surfaceColorSource: "orientation",
    });
  });

  it("preserves explicit vector component coloring when switching vector quantities", () => {
    expect(
      quantitySourcePatch(
        {
          ...DEFAULT_OBJECT_VISUALIZATION,
          surfaceColorSource: "component_z",
          vectorColorMode: "orientation",
        },
        "H_demag",
      ),
    ).toEqual({
      activeQuantityId: "H_demag",
    });
  });

  it("uses the shared freshness resolver for region visualization", () => {
    const scene = { objects: [{ id: "film", tags: ["mesh:ready"] }], revision: 12 };
    const staleManifest = {
      mesh_parts: [{ object_id: "film" }],
      source_scene_revision: 11,
    };

    expect(
      resolveObjectVisualizationPanelTopologyFreshness({
        manifest: staleManifest,
        scene,
        targetKind: "region",
      }),
    ).toBe("stale");
    expect(
      resolveObjectVisualizationPanelTopologyFreshness({
        manifest: staleManifest,
        scene,
        targetKind: "object",
      }),
    ).toBe("stale");
  });

  it("does not load the field catalog on object selection until surface coloring requests it", () => {
    expect(
      shouldLoadObjectVisualizationFieldCatalog({
        requested: false,
        surfaceColorSource: "orientation",
        targetActive: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadObjectVisualizationFieldCatalog({
        requested: true,
        surfaceColorSource: "orientation",
        targetActive: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadObjectVisualizationFieldCatalog({
        requested: true,
        surfaceColorSource: "solid",
        targetActive: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadObjectVisualizationFieldCatalog({
        requested: true,
        surfaceColorSource: "orientation",
        targetActive: false,
      }),
    ).toBe(false);
  });

  it("loads the field catalog for airbox vectors even when surface coloring is solid", () => {
    expect(
      shouldLoadObjectVisualizationFieldCatalog({
        requested: true,
        surfaceColorSource: "solid",
        targetActive: true,
        vectorsVisible: true,
      }),
    ).toBe(true);
  });

  it("keeps color picker input compatible with CSS token defaults", () => {
    expect(colorPickerInputValue("#00ffaa")).toBe("#00ffaa");
    expect(colorPickerInputValue("#00FFAA")).toBe("#00FFAA");
    expect(colorPickerInputValue("#babbf1")).toBe("#babbf1");
    expect(colorPickerInputValue("var(--fm-any-token)")).toBe("#ffffff");
  });

  it("turns a surface color picker value into a visible solid-color patch", () => {
    expect(surfaceSolidColorPatch("#00ffaa")).toEqual({
      shaderMonoColor: "#00ffaa",
      surfaceColorSource: "solid",
    });
  });

  it("turns the Surface display pass into surface-only rendering", () => {
    expect(surfaceDisplayPassPatch(DEFAULT_OBJECT_VISUALIZATION)).toMatchObject({
      pointsVisible: false,
      renderMode: "surface",
      shaderVisible: true,
      wireframeVisible: false,
    });
  });

  it("lets an already surface-only display pass toggle the surface off", () => {
    expect(
      surfaceDisplayPassPatch({
        ...DEFAULT_OBJECT_VISUALIZATION,
        pointsVisible: false,
        renderMode: "surface",
        shaderVisible: true,
        wireframeVisible: false,
      }),
    ).toEqual({ shaderVisible: false });
  });

  it("preserves a hidden target while computing pass-only patches", () => {
    const hiddenRegionSettings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      boundsVisible: false,
      pointsVisible: false,
      primitiveVisible: false,
      shaderVisible: false,
      vectorsVisible: false,
      visible: false,
      wireframeVisible: false,
    };

    expect(surfaceDisplayPassPatch(hiddenRegionSettings)).toMatchObject({
      shaderVisible: true,
    });
    expect(surfaceDisplayPassPatch(hiddenRegionSettings)).not.toHaveProperty("visible");
    expect(
      displayPassTogglePatch(hiddenRegionSettings, "wireframeVisible"),
    ).toEqual({ wireframeVisible: true });
    expect(
      displayPassTogglePatch(hiddenRegionSettings, "boundsVisible"),
    ).toEqual({ boundsVisible: true });
    expect(renderModeDisplayPatch("points")).toMatchObject({
      pointsVisible: true,
    });
    expect(renderModeDisplayPatch("points")).not.toHaveProperty("visible");
  });

  it("restores configured passes after a hidden target becomes visible", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "object:free-layer", kind: "object" as const };
    controller.patchTarget(target, {
      visible: false,
      wireframeVisible: true,
    });

    const hidden = resolveTargetVisualization({
      snapshot: controller.getSnapshot(),
      target,
    });
    expect(hidden.settings).toMatchObject({ visible: false, wireframeVisible: true });
    expect(hidden.effectiveSettings.wireframeVisible).toBe(false);

    controller.patchTarget(target, { visible: true });
    expect(
      resolveTargetVisualization({ snapshot: controller.getSnapshot(), target })
        .effectiveSettings,
    ).toMatchObject({ visible: true, wireframeVisible: true });
  });

  it("turns Full geometry scope into a visible volume-mesh pass when only the surface is active", () => {
    expect(
      geometryScopeDisplayPatch(
        {
          ...DEFAULT_OBJECT_VISUALIZATION,
          pointsVisible: false,
          renderMode: "surface",
          shaderVisible: true,
          wireframeVisible: false,
        },
        "full",
      ),
    ).toMatchObject({
      geometryScope: "full",
      renderMode: "surface+edges",
      shaderVisible: true,
      wireframeVisible: true,
    });
  });

  it("keeps Full geometry scope scoped-only when a volume-capable pass is already active", () => {
    expect(
      geometryScopeDisplayPatch(
        {
          ...DEFAULT_OBJECT_VISUALIZATION,
          renderMode: "wireframe",
          shaderVisible: false,
          wireframeVisible: true,
        },
        "full",
      ),
    ).toEqual({ geometryScope: "full" });
  });

  it("builds pass-specific sections for a visible object target", () => {
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolveEffectiveVisualizationSettings(
        DEFAULT_OBJECT_VISUALIZATION,
      ),
      settings: DEFAULT_OBJECT_VISUALIZATION,
    });

    expect(sections.map((section) => section.id)).toEqual([
      "display-passes",
      "quantity-source",
      "surface-coloring",
      "points",
      "wireframe",
      "vectors",
      "geometry-scope",
      "opacity",
      "overrides",
    ]);
    expect(sections.find((section) => section.id === "surface-coloring"))
      .toMatchObject({
        disabled: false,
        fields: expect.arrayContaining([
          expect.objectContaining({ id: "surfaceColorSource" }),
          expect.objectContaining({ id: "shaderMonoColor" }),
        ]),
      });
    expect(sections.find((section) => section.id === "quantity-source"))
      .toMatchObject({
        disabled: false,
        fields: [expect.objectContaining({ id: "activeQuantityId" })],
      });
  });

  it("marks pass-specific controls inactive while preserving configured values", () => {
    const hidden = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      vectorsVisible: true,
      visible: false,
    };
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolveEffectiveVisualizationSettings(hidden),
      settings: hidden,
    });

    expect(sections.find((section) => section.id === "surface-coloring"))
      .toMatchObject({ disabled: true });
    expect(sections.find((section) => section.id === "vectors"))
      .toMatchObject({ disabled: true });
  });

  it("keeps object vector controls active when the target inherits global vector visibility", () => {
    const visualization = new ObjectVisualizationController();
    const resolved = resolveTargetVisualization({
      snapshot: visualization.getSnapshot(),
      target: {
        id: "free-layer",
        kind: "object",
        label: "Free layer",
      },
      visualizationState: {
        layers: {
          vectors: {
            density: 512,
            domain: "full_domain",
            visible: true,
          },
        },
        revision: 11,
        vector_glyphs: true,
      } as never,
    });
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolved.effectiveSettings,
      settings: resolved.settings,
    });

    expect(resolved.settings.vectorsVisible).toBe(true);
    expect(sections.find((section) => section.id === "vectors")).toMatchObject({
      disabled: false,
    });
  });

  it("shows primitive display toggle only when primitive fallback can render", () => {
    expect(shouldShowPrimitiveDisplayToggle("geometry", "object", null)).toBe(true);
    expect(shouldShowPrimitiveDisplayToggle("geometry", "object", "unknown")).toBe(true);
    expect(shouldShowPrimitiveDisplayToggle("geometry", "object", "stale")).toBe(true);
    expect(shouldShowPrimitiveDisplayToggle("geometry", "object", "current")).toBe(false);
    expect(shouldShowPrimitiveDisplayToggle("study", "object", "stale")).toBe(false);
    expect(shouldShowPrimitiveDisplayToggle("results", "object", "unknown")).toBe(false);
    expect(shouldShowPrimitiveDisplayToggle("geometry", "part", "stale")).toBe(false);
    expect(shouldShowPrimitiveDisplayToggle("geometry", "airbox", null)).toBe(false);
  });

  it("keeps surface vector and wireframe fields addressable by target setting keys", () => {
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolveEffectiveVisualizationSettings(
        DEFAULT_OBJECT_VISUALIZATION,
      ),
      settings: DEFAULT_OBJECT_VISUALIZATION,
    });
    const fieldIds = sections.flatMap((section) =>
      section.fields.map((field) => field.id),
    );

    expect(fieldIds).toEqual(expect.arrayContaining([
      "surfaceColorSource",
      "activeQuantityId",
      "shaderMonoColor",
      "pointColor",
      "wireframeColor",
      "wireframeOpacityPercent",
      "vectorColorMode",
      "vectorMonoColor",
      "vectorAlphaPercent",
      "vectorThickness",
      "vectorSurfaceOffsetEnabled",
      "vectorSurfaceOffsetScale",
    ]));
  });

  it("scales the airbox arrow budget to the airbox node count", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        id: "part:__air__",
        label: "Airbox",
        node_count: 34668,
        role: "air",
      }),
      meshPart({
        id: "arch_waveguide",
        label: "Arch",
        node_count: 34229,
        role: "object",
      }),
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        meshParts,
        target: { id: "airbox", kind: "airbox" },
      }),
    ).toEqual({
      availableNodeCount: 34668,
      exact: true,
      max: 34668,
      min: 0,
      step: 1,
    });
  });

  it("scales object and part arrow budgets to their mesh node counts", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        geometry_id: "arch_waveguide_geom",
        id: "part:arch_waveguide_geom",
        label: "Arch",
        node_count: 34229,
        object_id: "arch_waveguide_geom",
        role: "object",
      }),
      meshPart({
        id: "cap",
        label: "Cap",
        node_count: 912,
        role: "object",
      }),
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        meshParts,
        target: { id: "arch_waveguide", kind: "object" },
      }),
    ).toMatchObject({
      availableNodeCount: 34229,
      exact: true,
      max: 34229,
    });
    expect(
      resolveVisualizationVectorBudgetRange({
        meshParts,
        target: { id: "cap", kind: "part" },
      }),
    ).toMatchObject({
      availableNodeCount: 912,
      exact: true,
      max: 912,
    });
  });

  it("scales region arrow budgets to mesh parts with encoded region target ids", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        geometry_id: "hole_refinement",
        id: "part:permalloy_box:hole_refinement",
        label: "Hole refinement",
        node_count: 512,
        object_id: "permalloy_box",
        role: "object",
      }),
      meshPart({
        geometry_id: "permalloy_box_geom",
        id: "part:permalloy_box",
        label: "Permalloy box",
        node_count: 2048,
        object_id: "permalloy_box",
        role: "object",
      }),
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        meshParts,
        target: {
          id: "region:permalloy_box:hole_refinement",
          kind: "region",
        },
      }),
    ).toMatchObject({
      availableNodeCount: 512,
      exact: true,
      max: 512,
    });
  });

  it("scales region arrow budgets when region ids are URL-encoded", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        geometry_id: "film:core",
        id: "part:film:core",
        label: "Core",
        node_count: 123,
        object_id: "film",
        role: "object",
      }),
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        meshParts,
        target: {
          id: "region:film:film%3Acore",
          kind: "region",
        },
      }),
    ).toMatchObject({
      availableNodeCount: 123,
      exact: true,
      max: 123,
    });
  });

  it("uses manifest region mesh parts before region id aliases for arrow budgets", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        geometry_id: "film:core",
        id: "part:film:alias-core",
        label: "Alias core",
        node_count: 123,
        object_id: "film",
        role: "object",
      }),
      meshPart({
        geometry_id: "realized-core",
        id: "part:film:realized-core",
        label: "Realized core",
        node_count: 456,
        object_id: "film",
        role: "object",
      }),
    ];
    const manifestRegions: NonNullable<
      MeshSharedDomainManifestResource["regions"]
    > = [
      {
        material_ref: "material:film",
        mesh_part_ids: ["part:film:realized-core"],
        name: "Core",
        region_id: "manifest:film:core",
        source_object_ids: ["film"],
        source_region_candidate_id: "film:core",
      },
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        manifestRegions,
        meshParts,
        target: {
          id: "region:film:film%3Acore",
          kind: "region",
        },
      }),
    ).toMatchObject({
      availableNodeCount: 456,
      exact: true,
      max: 456,
    });
  });

  it("resolves region visualization carriers from manifest mesh parts", () => {
    const manifestRegions: NonNullable<
      MeshSharedDomainManifestResource["regions"]
    > = [
      {
        material_ref: "material:film",
        mesh_part_ids: ["part:film:core"],
        name: "Core",
        region_id: "manifest:film:core",
        source_object_ids: ["film"],
        source_region_candidate_id: "film:core",
      },
      {
        material_ref: "material:film",
        mesh_part_ids: [],
        name: "Shell",
        region_id: "manifest:film:shell",
        source_object_ids: ["film"],
        source_region_candidate_id: "film:shell",
      },
    ];

    expect(
      resolveRegionVisualizationCarrier({
        manifestRegions,
        target: {
          id: "region:film:film%3Acore",
          kind: "region",
        },
      }),
    ).toEqual({
      kind: "mesh-parts",
      objectId: "film",
      partIds: ["part:film:core"],
      regionId: "film:core",
    });
    expect(
      resolveRegionVisualizationCarrier({
        manifestRegions: [
          {
            material_ref: "material:film",
            mesh_part_ids: ["part:film:geom-core"],
            name: "Core",
            region_id: "manifest:film:geom-core",
            source_object_ids: ["film_geom"],
            source_region_candidate_id: "film:core",
          },
        ],
        target: {
          id: "region:film:film%3Acore",
          kind: "region",
        },
      }),
    ).toEqual({
      kind: "mesh-parts",
      objectId: "film",
      partIds: ["part:film:geom-core"],
      regionId: "film:core",
    });
    expect(
      resolveRegionVisualizationCarrier({
        manifestRegions,
        target: {
          id: "region:film:film%3Ashell",
          kind: "region",
        },
      }),
    ).toMatchObject({
      kind: "unavailable",
    });
  });

  it("resolves region visualization carriers from memberships when not present in manifest regions", () => {
    const memberships = [
      {
        boundary_face_indices: [],
        element_indices: [1, 2, 3],
        mesh_id: "shared-domain",
        mesh_part_ids: [],
        mesh_revision: 1,
        node_indices: [1, 2, 3, 4],
        region_id: "film:shell",
        source: "test",
      },
    ];

    expect(
      resolveRegionVisualizationCarrier({
        manifestRegions: [],
        memberships,
        target: {
          id: "region:film:film%3Ashell",
          kind: "region",
        },
      }),
    ).toEqual({
      kind: "membership",
      objectId: "film",
      syntheticPartId: "membership:film%3Ashell",
      regionId: "film:shell",
    });
  });

  it("does not use alias-matched mesh parts for unrealized manifest regions", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        geometry_id: "film:core",
        id: "part:film:alias-core",
        label: "Alias core",
        node_count: 123,
        object_id: "film",
        role: "object",
      }),
    ];
    const manifestRegions: NonNullable<
      MeshSharedDomainManifestResource["regions"]
    > = [
      {
        material_ref: "material:film",
        mesh_part_ids: [],
        name: "Core",
        region_id: "manifest:film:core",
        source_object_ids: ["film"],
        source_region_candidate_id: "film:core",
      },
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        manifestRegions,
        meshParts,
        target: {
          id: "region:film:film%3Acore",
          kind: "region",
        },
      }),
    ).toEqual({
      availableNodeCount: 4096,
      exact: false,
      max: 4096,
      min: 0,
      step: 1,
    });
  });

  it("scales surface arrow budgets to surface node counts", () => {
    const meshParts: MeshPart[] = [
      meshPart({
        id: "part:arch_waveguide",
        label: "Arch",
        node_count: 8,
        object_id: "arch_waveguide",
        role: "object",
        surface_faces: [
          [0, 1, 2],
          [2, 3, 4],
        ],
      }),
    ];

    expect(
      resolveVisualizationVectorBudgetRange({
        geometryScope: "surface",
        meshParts,
        target: { id: "arch_waveguide", kind: "object" },
      }),
    ).toEqual({
      availableNodeCount: 5,
      exact: true,
      max: 5,
      min: 0,
      step: 1,
    });
  });

  it("expands full arrow budgets from the current surface coverage", () => {
    expect(
      geometryScopeVectorBudgetPatch({
        currentRange: {
          availableNodeCount: 5,
          exact: true,
          max: 5,
          min: 0,
          step: 1,
        },
        geometryScope: "full",
        nextRange: {
          availableNodeCount: 20,
          exact: true,
          max: 20,
          min: 0,
          step: 1,
        },
        settings: {
          ...DEFAULT_OBJECT_VISUALIZATION,
          geometryScope: "surface",
          vectorBudget: 5,
        },
      }),
    ).toEqual({
      geometryScope: "full",
      vectorBudget: 20,
    });
  });

  it("preserves partial arrow budget coverage when the vector extent changes", () => {
    expect(
      geometryScopeVectorBudgetPatch({
        currentRange: {
          availableNodeCount: 10,
          exact: true,
          max: 10,
          min: 0,
          step: 1,
        },
        geometryScope: "full",
        nextRange: {
          availableNodeCount: 40,
          exact: true,
          max: 40,
          min: 0,
          step: 1,
        },
        settings: {
          ...DEFAULT_OBJECT_VISUALIZATION,
          geometryScope: "surface",
          vectorBudget: 3,
        },
      }),
    ).toEqual({
      geometryScope: "full",
      vectorBudget: 12,
    });
  });

  it("reports displayed arrow samples against available target nodes", () => {
    expect(
      buildVisualizationVectorBudgetDiagnostic({
        requestedBudget: 12,
        vectorBudgetRange: {
          availableNodeCount: 5,
          exact: true,
          max: 5,
          min: 0,
          step: 1,
        },
      }),
    ).toEqual({
      availableNodeCount: 5,
      displayedGlyphCount: 5,
      exact: true,
      requestedBudget: 12,
    });
  });

  it("explains an airbox Visible request that is still off in backend state", () => {
    const diagnostic = buildAirboxVisibilityDiagnostic({
      displaySettings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: false,
        wireframeVisible: true,
      },
      renderWarning: null,
      settings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: false,
        wireframeVisible: true,
      },
    });

    expect(diagnostic).toMatchObject({
      status: "backend-off",
      title: "Airbox visibility not confirmed",
    });
    expect(diagnostic?.message).toContain("layers.airbox.visible=false");
    expect(diagnostic?.details).toEqual(
      expect.arrayContaining([
        { label: "Backend master", value: "off" },
        { label: "Wireframe pass", value: "on" },
      ]),
    );
  });

  it("confirms when airbox master visibility and a drawable pass are both active", () => {
    const diagnostic = buildAirboxVisibilityDiagnostic({
      displaySettings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: true,
        wireframeVisible: true,
      },
      renderWarning: null,
      settings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: true,
        wireframeVisible: true,
      },
    });

    expect(diagnostic).toMatchObject({
      status: "confirmed",
      title: "Airbox visibility confirmed",
    });
  });

  it("confirms airbox H_eff vectors when gates and catalog are available", () => {
    const fieldCatalog: FieldCatalogResource = {
      domain_generation_id: 1,
      quantities: [
        {
          available: true,
          components: 3,
          domain_generation_id: 1,
          field_revision: 3,
          kind: "vector",
          label: "Effective field",
          location: "full_domain",
          quantity_id: "H_eff",
          unit: "A/m",
        },
      ],
      revision: 4,
    };
    const diagnostic = buildAirboxVectorDiagnostic({
      airboxPartIds: ["part:__air__"],
      displaySettings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        activeQuantityId: "H_eff",
        vectorBudget: 1200,
        vectorsVisible: true,
        visible: true,
      },
      fieldCatalog,
      fieldCatalogStatus: "ready",
      renderWarning: null,
      settings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        activeQuantityId: "H_eff",
        vectorBudget: 1200,
        vectorsVisible: true,
        visible: true,
      },
      vectorDomain: "auto",
    });

    expect(diagnostic).toMatchObject({
      status: "confirmed",
      title: "Airbox vectors should be displayed",
    });
    expect(diagnostic.details).toEqual(
      expect.arrayContaining([
        { label: "Quantity", value: "H_eff" },
        {
          label: "Expected resource",
          value:
            `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&max_samples=1200&scope_kind=airbox`,
        },
        { label: "Catalog quantity", value: "available r3 full_domain" },
      ]),
    );
  });

  it("explains magnetic-only quantities blocking airbox vectors", () => {
    const diagnostic = buildAirboxVectorDiagnostic({
      airboxPartIds: ["part:__air__"],
      displaySettings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        activeQuantityId: "m",
        vectorsVisible: true,
        visible: true,
      },
      fieldCatalog: null,
      fieldCatalogStatus: "idle",
      renderWarning: null,
      settings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        activeQuantityId: "m",
        vectorsVisible: true,
        visible: true,
      },
      vectorDomain: "auto",
    });

    expect(diagnostic).toMatchObject({
      status: "blocked",
      title: "Airbox vectors are not scheduled",
    });
    expect(diagnostic.message).toContain("magnetic-only");
  });
});

function meshPart(
  part: Partial<MeshPart> &
    Pick<MeshPart, "id" | "label" | "node_count" | "role">,
): MeshPart {
  return {
    boundary_face_count: 0,
    boundary_face_start: 0,
    element_count: 0,
    element_start: 0,
    node_start: 0,
    ...part,
  };
}
