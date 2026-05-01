import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/src/api/types";
import { DEFAULT_FEM_VIEWPORT_LAYER_STATE } from "@/features/viewport-unified/model/unifiedViewportTypes";
import {
  airboxPassesFromVisualizationState,
  femLayersFromVisualizationState,
  femVectorDomainFromVisualizationState,
  opacityUnitToPercent,
  projectResolvedRenderPlanToViewportState,
  renderModeFromVisualizationState,
  renderPassesFromVisualizationState,
  resolveRenderPlanFromVisualizationState,
  sliceToolbarFromVisualizationState,
  visualizationPatchForClip,
  visualizationPatchForFemLayers,
  visualizationPatchForOpacity,
  visualizationPatchForRenderMode,
  visualizationPatchForVectorStyle,
} from "../visualizationStateSync";

function state(
  patch: Partial<VisualizationStateResource> = {},
): VisualizationStateResource {
  return {
    revision: 1,
    schema_version: 2,
    quantity: {
      active_quantity_id: "m",
      field_component: "magnitude",
      colormap: "viridis",
      auto_contrast: true,
      contrast_min: null,
      contrast_max: null,
    },
    layers: {
      surface: { visible: true, opacity: 1 },
      quantity_overlay: { visible: true, opacity: 1 },
      wireframe: { visible: false, opacity: 1 },
      volume_mesh: { visible: false, opacity: 1 },
      points: { visible: false, opacity: 1 },
      vectors: { visible: false, density: 1, domain: "auto" },
      primitives: { visible: true, opacity: 1 },
      airbox: {
        visible: false,
        surface: { visible: false, opacity: 0.18 },
        wireframe: { visible: false, opacity: 1 },
        points: { visible: false, opacity: 1 },
        vectors: { visible: false, density: 1, domain: "airbox_only" },
        opacity: 0.18,
      },
    },
    domains: {
      active_scope: "full",
      object_id: null,
      part_id: null,
    },
    sampling: {
      profile: "balanced",
      max_points: 50_000,
      max_glyphs: 1_200,
      max_bytes: null,
      progressive: true,
    },
    fdm: {
      x_chosen_size: 128,
      y_chosen_size: 128,
    },
    fem: {
      topology_mode: "auto",
      volume_edges_budget: 100_000,
    },
    slice: {
      quantity_id: "m",
      component: "magnitude",
      axis: "z",
      mode: "single",
      layer_index: 0,
      position_percent: 50,
      thickness_percent: null,
      colormap: "viridis",
      auto_contrast: true,
      show_primitives: true,
      show_mesh: false,
      show_magnetic_texture: true,
      show_airbox: false,
      airbox_render_mode: "wireframe",
      show_airbox_vectors: false,
      show_quantity: true,
      show_vectors: false,
      render_mode: "heatmap",
    },
    clip: {
      enabled: false,
      axis: "x",
      position_percent: 50,
      flipped: false,
    },
    vector_style: {
      color_mode: "orientation",
      mono_color: "#00c2ff",
      alpha: 1,
      length_scale: 1,
      thickness: 1,
      ferromagnet_visibility: "hide",
    },
    overrides: [],
    diagnostics: {
      warnings: [],
      degraded_reasons: [],
    },
    active_quantity_id: "m",
    view_mode: "3d",
    field_component: "magnitude",
    colormap: "viridis",
    auto_contrast: true,
    contrast_min: null,
    contrast_max: null,
    vector_glyphs: false,
    vector_density: 1,
    slice_mode: "single",
    slice_layer: 0,
    max_points: 50_000,
    x_chosen_size: 128,
    y_chosen_size: 128,
    ...patch,
  };
}

describe("visualization state local sync", () => {
  it("derives mesh render mode from independent layer state", () => {
    expect(renderModeFromVisualizationState(state())).toBe("surface");
    expect(renderModeFromVisualizationState(state({
      layers: { ...state().layers, wireframe: { visible: true, opacity: 1 } },
    }))).toBe("surface+edges");
    expect(renderModeFromVisualizationState(state({
      layers: { ...state().layers, points: { visible: true, opacity: 1 } },
    }))).toBe("points");
  });

  it("derives the 2D slice toolbar from canonical visualization slice state", () => {
    const next = sliceToolbarFromVisualizationState(state({
      slice: {
        quantity_id: "H_eff",
        component: "x",
        axis: "y",
        mode: "slab",
        layer_index: 4,
        position_percent: 25,
        thickness_percent: 12,
        colormap: "magma",
        auto_contrast: false,
        show_primitives: false,
        show_mesh: true,
        show_magnetic_texture: false,
        show_airbox: true,
        airbox_render_mode: "points",
        show_airbox_vectors: true,
        show_quantity: true,
        show_vectors: true,
        render_mode: "vectors",
      },
    }));

    expect(next).toMatchObject({
      quantityId: "H_eff",
      component: "x",
      axis: "y",
      mode: "slab",
      layerIndex: 4,
      positionPercent: 25,
      airboxRenderMode: "points",
      showAirboxVectors: true,
      renderMode: "vectors",
    });
  });

  it("keeps magnetic texture independent while syncing canonical layers", () => {
    const next = femLayersFromVisualizationState(
      state({
        layers: {
          ...state().layers,
          primitives: { visible: false, opacity: 1 },
          quantity_overlay: { visible: false, opacity: 1 },
          wireframe: { visible: true, opacity: 1 },
        },
      }),
      {
        showPrimitives: true,
        showMesh: false,
        showMagneticTexture: true,
        showQuantity: true,
      },
    );

    expect(next).toEqual({
      showPrimitives: false,
      showMesh: true,
      showMagneticTexture: true,
      showQuantity: false,
    });
  });

  it("normalizes opacity and domain filters for viewport controls", () => {
    expect(opacityUnitToPercent(0.42, 100)).toBe(42);
    expect(opacityUnitToPercent(88, 100)).toBe(88);
    expect(femVectorDomainFromVisualizationState("airbox_only")).toBe("airbox_only");
    expect(femVectorDomainFromVisualizationState("selection")).toBeNull();
  });

  it("keeps render passes independent from render mode presets", () => {
    const next = state({
      layers: {
        ...state().layers,
        surface: { visible: true, opacity: 1 },
        wireframe: { visible: true, opacity: 1 },
        volume_mesh: { visible: true, opacity: 1 },
        points: { visible: true, opacity: 1 },
        vectors: { visible: true, density: 1, domain: "full_domain" },
        quantity_overlay: { visible: false, opacity: 1 },
        airbox: {
          ...state().layers.airbox,
          visible: true,
          surface: { visible: true, opacity: 0.18 },
          wireframe: { visible: true, opacity: 1 },
          points: { visible: true, opacity: 1 },
          vectors: { visible: true, density: 1, domain: "airbox_only" },
          opacity: 0.19,
        },
      },
    });

    expect(renderModeFromVisualizationState(next)).toBe("points");
    expect(renderPassesFromVisualizationState(next)).toEqual({
      surface: true,
      wireframe: true,
      volumeMesh: true,
      points: true,
      vectors: true,
      quantityOverlay: false,
    });
    expect(airboxPassesFromVisualizationState(next)).toEqual({
      visible: true,
      surface: true,
      wireframe: true,
      points: true,
      vectors: true,
      opacityPercent: 19,
    });
  });

  it("resolves one render plan from canonical visualization state", () => {
    const plan = resolveRenderPlanFromVisualizationState(
      state({
        layers: {
          ...state().layers,
          surface: { visible: true, opacity: 0.41 },
          wireframe: { visible: true, opacity: 1 },
          vectors: { visible: true, density: 2, domain: "airbox_only" },
          airbox: {
            ...state().layers.airbox,
            visible: true,
            surface: { visible: true, opacity: 0.22 },
            wireframe: { visible: true, opacity: 1 },
            vectors: { visible: true, density: 1, domain: "airbox_only" },
            opacity: 0.22,
          },
        },
        sampling: {
          ...state().sampling,
          max_glyphs: 777,
          profile: "memory_saver",
          progressive: false,
        },
        clip: {
          enabled: true,
          axis: "z",
          position_percent: 12.5,
          flipped: true,
        },
        vector_style: {
          color_mode: "magnitude",
          mono_color: "#ffcc00",
          alpha: 0.75,
          length_scale: 1.5,
          thickness: 2,
          ferromagnet_visibility: "ghost",
        },
      }),
      {
        showPrimitives: true,
        showMesh: false,
        showMagneticTexture: true,
        showQuantity: true,
      },
    );

    expect(plan.layers).toEqual({
      renderMode: "surface+edges",
      meshOpacityPercent: 41,
      vectorsVisible: true,
      vectorDomainFilter: "airbox_only",
      femLayers: {
        showPrimitives: true,
        showMesh: true,
        showMagneticTexture: true,
        showQuantity: true,
      },
      passes: {
        surface: true,
        wireframe: true,
        volumeMesh: false,
        points: false,
        vectors: true,
        quantityOverlay: true,
      },
      airbox: {
        visible: true,
        surface: true,
        wireframe: true,
        points: false,
        vectors: true,
        opacityPercent: 22,
      },
      airboxVisible: true,
      airboxOpacityPercent: 22,
    });
    expect(plan.sampling).toEqual({
      maxPoints: 50_000,
      maxGlyphs: 777,
      profile: "memory_saver",
      progressive: false,
    });
    expect(plan.clip).toEqual({
      enabled: true,
      axis: "z",
      positionPercent: 12.5,
      flipped: true,
    });
    expect(plan.vectorStyle).toEqual({
      colorMode: "magnitude",
      monoColor: "#ffcc00",
      alpha: 0.75,
      lengthScale: 1.5,
      thickness: 2,
      ferromagnetVisibility: "ghost",
    });
  });

  it("projects a resolved render plan into the viewport visualization state", () => {
    const fallback = {
      meshRenderMode: "surface" as const,
      meshOpacity: 100,
      meshClipEnabled: false,
      meshClipAxis: "x" as const,
      meshClipPos: 50,
      meshClipFlip: false,
      meshShowArrows: false,
      femVectorGlyphBudget: 1_200,
      femArrowColorMode: "orientation" as const,
      femArrowMonoColor: "#00c2ff",
      femArrowAlpha: 1,
      femArrowLengthScale: 1,
      femArrowThickness: 1,
      femVectorDomainFilter: "auto" as const,
      femFerromagnetVisibilityMode: "hide" as const,
      femViewportLayers: DEFAULT_FEM_VIEWPORT_LAYER_STATE,
      airMeshVisible: false,
      airMeshOpacity: 28,
    };
    const baseState = state();
    const plan = resolveRenderPlanFromVisualizationState(
      state({
        layers: {
          ...baseState.layers,
          surface: { visible: true, opacity: 0.42 },
          wireframe: { visible: true, opacity: 1 },
          vectors: { visible: true, density: 1, domain: "magnetic_only" },
          airbox: {
            ...baseState.layers.airbox,
            visible: true,
            opacity: 0.31,
          },
        },
        sampling: {
          ...baseState.sampling,
          max_glyphs: 3456,
        },
        clip: {
          enabled: true,
          axis: "z",
          position_percent: 72,
          flipped: true,
        },
        vector_style: {
          color_mode: "monochrome",
          mono_color: "#ff00aa",
          alpha: 0.6,
          length_scale: 1.8,
          thickness: 2.4,
          ferromagnet_visibility: "ghost",
        },
      }),
      DEFAULT_FEM_VIEWPORT_LAYER_STATE,
    );

    expect(projectResolvedRenderPlanToViewportState(plan, fallback)).toMatchObject({
      meshRenderMode: "surface+edges",
      meshOpacity: 42,
      meshClipEnabled: true,
      meshClipAxis: "z",
      meshClipPos: 72,
      meshClipFlip: true,
      meshShowArrows: true,
      femVectorGlyphBudget: 3456,
      femArrowColorMode: "monochrome",
      femArrowMonoColor: "#ff00aa",
      femArrowAlpha: 0.6,
      femArrowLengthScale: 1.8,
      femArrowThickness: 2.4,
      femVectorDomainFilter: "magnetic_only",
      femFerromagnetVisibilityMode: "ghost",
      airMeshVisible: true,
      airMeshOpacity: 31,
    });
  });

  it("keeps the fallback adapter state when no render plan is available", () => {
    const fallback = {
      meshRenderMode: "points" as const,
      meshOpacity: 12,
      meshClipEnabled: true,
      meshClipAxis: "y" as const,
      meshClipPos: 25,
      meshClipFlip: true,
      meshShowArrows: true,
      femVectorGlyphBudget: 99,
      femArrowColorMode: "x" as const,
      femArrowMonoColor: "#fff",
      femArrowAlpha: 0.2,
      femArrowLengthScale: 0.5,
      femArrowThickness: 0.75,
      femVectorDomainFilter: "airbox_only" as const,
      femFerromagnetVisibilityMode: "ghost" as const,
      femViewportLayers: DEFAULT_FEM_VIEWPORT_LAYER_STATE,
      airMeshVisible: true,
      airMeshOpacity: 19,
    };

    expect(projectResolvedRenderPlanToViewportState(null, fallback)).toBe(fallback);
  });

  it("builds canonical patches for viewport toolbar controls", () => {
    expect(visualizationPatchForRenderMode("points")).toEqual({
      layers: {
        surface: { visible: false },
        wireframe: { visible: false },
        volume_mesh: { visible: false },
        points: { visible: true },
      },
      fem: { topology_mode: "surface" },
    });
    expect(visualizationPatchForOpacity(42)).toEqual({
      layers: {
        surface: { opacity: 0.42 },
        quantity_overlay: { opacity: 0.42 },
      },
    });
    expect(visualizationPatchForFemLayers({
      showPrimitives: false,
      showMesh: true,
      showMagneticTexture: true,
      showQuantity: false,
    })).toEqual({
      layers: {
        primitives: { visible: false },
        quantity_overlay: { visible: false },
        wireframe: { visible: true },
      },
    });
    expect(visualizationPatchForClip({
      enabled: true,
      axis: "z",
      positionPercent: 37.5,
      flipped: true,
    })).toEqual({
      clip: {
        enabled: true,
        axis: "z",
        position_percent: 37.5,
        flipped: true,
      },
    });
    expect(visualizationPatchForVectorStyle({
      colorMode: "magnitude",
      monoColor: "#ff3366",
      alpha: 0.5,
      lengthScale: 1.25,
      thickness: 2,
      ferromagnetVisibility: "ghost",
    })).toEqual({
      vector_style: {
        color_mode: "magnitude",
        mono_color: "#ff3366",
        alpha: 0.5,
        length_scale: 1.25,
        thickness: 2,
        ferromagnet_visibility: "ghost",
      },
    });
  });
});
