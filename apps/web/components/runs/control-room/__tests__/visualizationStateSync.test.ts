import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/src/api/types";
import {
  femLayersFromVisualizationState,
  femVectorDomainFromVisualizationState,
  opacityUnitToPercent,
  renderModeFromVisualizationState,
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

  it("normalizes opacity and domain filters for legacy controls", () => {
    expect(opacityUnitToPercent(0.42, 100)).toBe(42);
    expect(opacityUnitToPercent(88, 100)).toBe(88);
    expect(femVectorDomainFromVisualizationState("airbox_only")).toBe("airbox_only");
    expect(femVectorDomainFromVisualizationState("selection")).toBeNull();
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
