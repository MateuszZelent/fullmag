import { describe, expect, it } from "vitest";

import {
  planarInteractionPatch,
  planarLayerPatch,
  planarPresentationPatchFromThreeDimensional,
  planarRangeForMode,
  planarResolutionPatch,
  planarVectorStylePatch,
} from "./presentationSemantics";

const layers = {
  boundaries: true,
  bounds: false,
  contours: false,
  mesh: true,
  points: false,
  probes: true,
  raster: true,
  vectors: false,
};

describe("planar presentation semantics", () => {
  it.each(["raster", "bounds", "contours", "mesh", "boundaries", "points", "vectors", "probes"] as const)(
    "maps the %s control to the full typed layers resource patch",
    (layer) => {
      expect(planarLayerPatch(layers, layer)).toEqual({
        layers: { ...layers, [layer]: !layers[layer] },
      });
    },
  );

  it("preserves SI manual range and clears limits for auto and symmetric", () => {
    const manual = { mode: "manual" as const, min: -2500, max: 4000 };
    expect(planarRangeForMode("manual", manual)).toEqual(manual);
    expect(planarRangeForMode("auto", manual)).toEqual({ mode: "auto", min: null, max: null });
    expect(planarRangeForMode("symmetric", manual)).toEqual({ mode: "symmetric", min: null, max: null });
  });

  it("patches quality, resolution, vector style and interaction independently", () => {
    expect(planarResolutionPatch({ height: 256, vector_budget: 512, width: 512 }, { vector_budget: 768 })).toEqual({
      resolution: { height: 256, vector_budget: 768, width: 512 },
    });
    expect(planarVectorStylePatch({ color_mode: "orientation", length_mode: "uniform", scale: 1 }, { scale: 1.5 })).toEqual({
      vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1.5 },
    });
    expect(planarInteractionPatch({ pan_u_m: 0, pan_v_m: 0, zoom: 1 }, { zoom: 2 })).toEqual({
      interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 2 },
    });
  });

  it("maps shared 3D quiver style and preserves the nondefault vector budget", () => {
    expect(planarPresentationPatchFromThreeDimensional({ vectorBudget: 768, vectorColorMode: "magnitude", vectorLengthScale: 1.25 }, { height: 256, vector_budget: 512, width: 512 })).toEqual({
      resolution: { height: 256, vector_budget: 768, width: 512 },
      vector_style: {
        color_mode: "magnitude",
        length_mode: "uniform",
        scale: 1.25,
      },
    });
    expect(planarPresentationPatchFromThreeDimensional({ vectorBudget: 768, vectorColorMode: "x", vectorLengthScale: 1.25 }, { height: 256, vector_budget: 512, width: 512 })).toBeNull();
  });
});
