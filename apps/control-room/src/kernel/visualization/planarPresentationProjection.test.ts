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
    component: "magnitude",
    display_unit: "A/m",
    interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
    layers: { boundaries: true, contours: false, mesh: true, probes: false, raster: true, vectors: true },
    quality: "interactive" as const,
    quantity_id: "h_eff",
    range: { mode: "auto" as const, min: null, max: null },
    raster_opacity: 1,
    resolution: { height: 256, vector_budget: 512, width: 512 },
    vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
    view_scope: { kind: "monitor_target" as const },
  },
};

describe("projectPlanarPresentationState", () => {
  it("shows pending presentation fields without adopting identity, quality, or resolution", () => {
    const projected = projectPlanarPresentationState(base as unknown as VisualizationStateResource, {
      planar: {
        ...base.planar,
        source: { kind: "monitor" as const, monitor_id: "monitor-pending" },
        component: "normal",
        layers: { ...base.planar.layers, vectors: false },
        quality: "export",
        quantity_id: "m",
        resolution: { height: 1024, vector_budget: 1000, width: 1024 },
      },
    } as unknown as VisualizationStateResource);

    expect(projected).toMatchObject({
      source: { kind: "monitor", monitor_id: "monitor-authoritative" },
      component: "magnitude",
      layers: { vectors: false },
      quality: "interactive",
      quantity_id: "h_eff",
      resolution: { height: 256, vector_budget: 512, width: 512 },
    });
  });
});
