import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "../api/apiTypes";
import { projectPlanarPresentationState } from "./planarPresentationProjection";

const base = {
  planar: {
    active_monitor_id: "monitor-authoritative",
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
  it("shows a pending layer hide immediately without adopting pending source identity", () => {
    const projected = projectPlanarPresentationState(base as VisualizationStateResource, {
      planar: {
        ...base.planar,
        active_monitor_id: "monitor-pending",
        component: "normal",
        layers: { ...base.planar.layers, vectors: false },
        quantity_id: "m",
      },
    } as VisualizationStateResource);

    expect(projected).toMatchObject({
      active_monitor_id: "monitor-authoritative",
      component: "magnitude",
      layers: { vectors: false },
      quantity_id: "h_eff",
    });
  });
});
