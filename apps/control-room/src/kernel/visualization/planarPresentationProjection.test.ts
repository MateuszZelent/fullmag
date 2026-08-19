import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "../api/apiTypes";
import { projectPlanarPresentationState } from "./planarPresentationProjection";

const base = {
  planar: {
    source: { kind: "monitor" as const, monitor_id: "monitor-authoritative" },
    default_slice: {
      operator: { kind: "plane_sample" as const },
      plane: "xy" as const,
      position_fraction: 0.5,
    },
    colormap: "viridis",
    visible: true,
    component: "magnitude",
    display_unit: "A/m",
    interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
    layers: { boundaries: true, contours: false, mesh: true, probes: false, raster: true, vectors: true },
    quality: "interactive" as const,
    quantity_id: "h_eff",
    range: { mode: "auto" as const, min: null, max: null },
    raster_opacity: 1,
    viewport_colorbar_visible: true,
    wireframe_style: { color: "#ffffff", opacity: 1 },
    point_style: { color: "#00ff00", opacity: 1, size: 3 },
    resolution: { height: 256, vector_budget: 512, width: 512 },
    vector_style: { color_mode: "orientation", length_mode: "uniform", monochrome_color: "#ffffff", opacity: 1, scale: 1, thickness: 1 },
    view_scope: { kind: "monitor_target" as const },
    target_overrides: [
      {
        scope: "object" as const,
        scope_id: "free-layer",
        wireframe_style: { color: "#ffffff", opacity: 1 },
      },
    ],
  },
  overrides: [
    {
      scope: "object" as const,
      scope_id: "free-layer",
      visible: true,
    },
  ],

};

describe("projectPlanarPresentationState", () => {
  it("shows pending presentation fields without adopting identity, quality, or resolution", () => {
    const projected = projectPlanarPresentationState(base as unknown as VisualizationStateResource, {
      planar: {
        ...base.planar,
        source: { kind: "monitor" as const, monitor_id: "monitor-pending" },
        component: "normal",
        visible: false,
        layers: { ...base.planar.layers, vectors: false },
        viewport_colorbar_visible: false,
        wireframe_style: { color: "#ff0000", opacity: 0.4 },
        point_style: { color: "#0000ff", opacity: 0.5, size: 6 },
        vector_style: { ...base.planar.vector_style, opacity: 0.3, thickness: 2 },
        target_overrides: [
          {
            scope: "airbox" as const,
            scope_id: "airbox",
            wireframe_style: { color: "#ff00ff", opacity: 0.2 },
          },
        ],
        quality: "export",
        quantity_id: "m",
        resolution: { height: 1024, vector_budget: 1000, width: 1024 },
      },
    } as unknown as VisualizationStateResource);

    expect(projected).toMatchObject({
      source: { kind: "monitor", monitor_id: "monitor-authoritative" },
      component: "magnitude",
      visible: false,
      layers: { vectors: false },
      viewport_colorbar_visible: false,
      wireframe_style: { color: "#ff0000", opacity: 0.4 },
      point_style: { color: "#0000ff", opacity: 0.5, size: 6 },
      vector_style: { opacity: 0.3, thickness: 2 },
      quality: "interactive",
      target_overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          wireframe_style: { color: "#ff00ff", opacity: 0.2 },
        },
      ],
      quantity_id: "h_eff",
      resolution: { height: 256, vector_budget: 512, width: 512 },
    });
    expect((base as unknown as VisualizationStateResource).overrides).toEqual([
      {
        scope: "object",
        scope_id: "free-layer",
        visible: true,
      },
    ]);
  });
});
