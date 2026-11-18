import { describe, expect, it } from "vitest";

import type { PlanarFieldLayer, PlanarLayerState } from "@/modules/inspector/public";

import { planarCompositionLayers, planarLayerPasses } from "./PlanarCompositionSurface";
import { multisliceLayerProps, type PlanarMultisliceGridProps } from "./PlanarMultisliceGrid";

const masks: PlanarLayerState = {
  boundaries: false, bounds: false, contours: false, mesh: false, points: false,
  probes: true, raster: true, streamlines: false, vectors: false,
};

function layer(id: string, overrides: Partial<PlanarFieldLayer> = {}): PlanarFieldLayer {
  return {
    id,
    view_scope: id === "airbox" ? { kind: "airbox" } : { kind: "object", scope_id: id },
    quantity_id: "m",
    component: "magnitude",
    colormap: "hsl_direction",
    range: { mode: "auto", min: null, max: null },
    raster_opacity: 1,
    raster_visible: true,
    vectors_visible: false,
    vector_style: { color_mode: "orientation", length_mode: "uniform", monochrome_color: "white", opacity: 1, scale: 1, thickness: 1 },
    visible: true,
    ...overrides,
  };
}

describe("planar layer composition", () => {
  it("draws from the end of the list to the start and skips hidden layers", () => {
    const layers = [layer("film"), layer("hidden", { visible: false }), layer("airbox", { quantity_id: "H_demag" })];
    expect(planarCompositionLayers(layers, masks).map(({ profile }) => profile.id)).toEqual(["airbox", "film"]);
  });

  it("leaves out a layer whose passes are all masked or off, so it requests no data", () => {
    const vectorsOnly = layer("film", { raster_visible: false, vectors_visible: true });
    expect(planarCompositionLayers([vectorsOnly], masks)).toEqual([]);
    expect(planarCompositionLayers([vectorsOnly], { ...masks, vectors: true })).toHaveLength(1);
  });

  it("applies view mask AND layer flag per pass", () => {
    const passes = planarLayerPasses(layer("film", { vectors_visible: true, contours_visible: true }), { ...masks, contours: true });
    expect(passes).toMatchObject({ raster: true, vectors: false, contours: true, points: false });
  });

  it("points multislice panels at the layer's quantity, scope and colouring", () => {
    const base = {
      baseQuery: { component: "x", scope_kind: "monitor_target", vector_budget: 0 },
      clientComponent: "x",
      colorByDirection: false,
      colormap: "viridis",
      positionFractions: [0.25, 0.75],
      quantityId: "h_eff",
      range: null,
      rasterOpacity: 0.5,
      renderLegend: () => null,
      requestVectors: false,
      source: { kind: "default" },
    } as unknown as PlanarMultisliceGridProps;
    const props = multisliceLayerProps(base, layer("film", { quantity_id: "m" }));
    expect(props).toMatchObject({
      quantityId: "m",
      colormap: "hsl_direction",
      colorByDirection: true,
      requestVectors: true,
      clientComponent: null,
      rasterOpacity: 1,
      baseQuery: { component: "magnitude", scope_kind: "object", scope_id: "film" },
    });
    expect(props.baseQuery.vector_budget).toBeGreaterThan(0);
  });
});
