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
  buildAirboxVisibilityDiagnostic,
  buildVisualizationVectorBudgetDiagnostic,
  buildVisualizationPanelSections,
  colorPickerInputValue,
  geometryScopeDisplayPatch,
  quantitySourcePatch,
  resolveSurfaceColorSourceItems,
  resolveObjectVisualizationPanelTopologyFreshness,
  scalarColorPalettePatch,
  resolveVisualizationVectorBudgetRange,
  shouldShowPrimitiveDisplayToggle,
  shouldLoadObjectVisualizationFieldCatalog,
  shouldShowSurfaceFieldColorbar,
  SURFACE_COLOR_SOURCE_ITEMS,
  surfaceColorSourceFieldMetaComponent,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  VISUALIZATION_COLOR_MODE_ITEMS,
  VISUALIZATION_QUANTITY_ITEMS,
  visualizationQuantityItems,
} from "./ObjectVisualizationPanelModel";

type MeshPart = NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];

describe("ObjectVisualizationPanelModel", () => {
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

  it("exposes target quantity options for the inspector visualization panel", () => {
    expect(VISUALIZATION_QUANTITY_ITEMS.map((item) => item.value)).toEqual([
      "m",
      "H_eff",
      "H_demag",
      "H_ex",
      "H_ani",
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

  it("shows inspector colorbars only for numeric surface color modes", () => {
    expect(shouldShowSurfaceFieldColorbar("component_x", "m")).toBe(true);
    expect(shouldShowSurfaceFieldColorbar("magnitude", "m")).toBe(true);
    expect(shouldShowSurfaceFieldColorbar("colormap", "mat_ms")).toBe(true);
    expect(shouldShowSurfaceFieldColorbar("orientation", "m")).toBe(false);
    expect(shouldShowSurfaceFieldColorbar("solid", "m")).toBe(false);
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

  it("does not force region visualization through mesh topology safety mode", () => {
    const scene = { objects: [{ id: "film", tags: ["mesh:dirty"] }], revision: 2 };
    const staleManifest = { source_scene_revision: 1 };

    expect(
      resolveObjectVisualizationPanelTopologyFreshness({
        manifest: staleManifest,
        scene,
        targetKind: "region",
      }),
    ).toBeNull();
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
            `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_kind=airbox&max_samples=1200`,
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
