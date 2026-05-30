import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import { resolveViewport2DCrossSectionQuery } from "./viewport2dQuery";

function visualizationState(
  patch: Partial<VisualizationStateResource>,
): VisualizationStateResource {
  return {
    clip: {
      axis: "z",
      enabled: false,
      flipped: false,
      position_percent: 50,
    },
    revision: 1,
    slice: {
      axis: "z",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      position_percent: 50,
      projection_include_air_as_zero: true,
      projection_reduction: "mean",
      projection_resolution: 128,
      projection_samples: 32,
      quantity_id: "m",
      render_mode: "scalar",
      show_airbox: true,
      show_airbox_vectors: false,
      show_magnetic_texture: true,
      show_mesh: true,
      show_primitives: true,
      show_quantity: true,
      show_vectors: false,
      airbox_render_mode: "scalar",
      layer_index: null,
      mode: "plane",
      thickness_percent: null,
    },
    ...patch,
  } as VisualizationStateResource;
}

describe("resolveViewport2DCrossSectionQuery", () => {
  it("follows the active 3D clip plane when clipping is enabled", () => {
    expect(
      resolveViewport2DCrossSectionQuery(
        visualizationState({
          clip: {
            axis: "x",
            enabled: true,
            flipped: false,
            position_percent: 62.5,
          },
        }),
      ),
    ).toEqual({
      includePolygons: true,
      includeWireframe: true,
      plane: "yz",
      positionPercent: 62.5,
    });
  });

  it("falls back to the slice plane while the 3D clip plane is disabled", () => {
    expect(
      resolveViewport2DCrossSectionQuery(
        visualizationState({
          slice: {
            ...visualizationState({}).slice,
            axis: "y",
            position_percent: 12.25,
          },
        }),
      ),
    ).toMatchObject({
      plane: "xz",
      positionPercent: 12.25,
    });
  });

  it("uses a stable mid-XY query before visualization state loads", () => {
    expect(resolveViewport2DCrossSectionQuery(null)).toEqual({
      includePolygons: true,
      includeWireframe: true,
      plane: "xy",
      positionPercent: 50,
    });
  });
});
