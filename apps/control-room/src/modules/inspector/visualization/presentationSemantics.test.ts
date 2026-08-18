import { describe, expect, it } from "vitest";

import {
  planarDisplayModePatch,
  planarInteractionPatch,
  planarLayerPatch,
  planarPresentationPatchFromThreeDimensional,
  planarRangeForMode,
  planarResolutionPatch,
  planarVectorStylePatch,
  resolvePlanarDisplayMode,
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
  const vectorStyle = {
    color_mode: "orientation",
    length_mode: "uniform",
    monochrome_color: "#cdd6f4",
    opacity: 0.8,
    scale: 1,
    thickness: 1.5,
  };
  it.each([
    ["surface", { raster: true, mesh: false, boundaries: false, points: false }],
    ["surface+edges", { raster: true, mesh: true, boundaries: true, points: false }],
    ["wireframe", { raster: false, mesh: true, boundaries: true, points: false }],
    ["points", { raster: false, mesh: false, boundaries: false, points: true }],
    ["off", { raster: false, mesh: false, boundaries: false, points: false }],
  ] as const)("maps the %s render mode without changing independent overlays", (mode, primary) => {
    expect(planarDisplayModePatch(mode, layers)).toEqual({
      layers: {
        ...layers,
        ...primary,
      },
    });
  });

  it.each([
    [{ ...layers, raster: true, mesh: false, boundaries: false, points: false }, "surface"],
    [{ ...layers, raster: true, mesh: true, boundaries: true, points: false }, "surface+edges"],
    [{ ...layers, raster: false, mesh: true, boundaries: true, points: false }, "wireframe"],
    [{ ...layers, raster: false, mesh: false, boundaries: false, points: true }, "points"],
    [{ ...layers, raster: false, mesh: false, boundaries: false, points: false }, "off"],
  ] as const)("resolves the primary planar layers to %s", (candidate, mode) => {
    expect(resolvePlanarDisplayMode(candidate)).toBe(mode);
  });

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
    expect(planarVectorStylePatch(vectorStyle, { scale: 1.5 })).toEqual({
      vector_style: { ...vectorStyle, scale: 1.5 },
    });
    expect(planarInteractionPatch({ pan_u_m: 0, pan_v_m: 0, zoom: 1 }, { zoom: 2 })).toEqual({
      interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 2 },
    });
  });

  it("maps shared 3D quiver style and preserves the nondefault vector budget", () => {
    expect(planarPresentationPatchFromThreeDimensional({ vectorBudget: 768, vectorColorMode: "magnitude", vectorLengthScale: 1.25 }, { height: 256, vector_budget: 512, width: 512 }, vectorStyle)).toEqual({
      resolution: { height: 256, vector_budget: 768, width: 512 },
      vector_style: {
        ...vectorStyle,
        color_mode: "magnitude",
        length_mode: "uniform",
        scale: 1.25,
      },
    });
    expect(planarPresentationPatchFromThreeDimensional({ vectorBudget: 768, vectorColorMode: "x", vectorLengthScale: 1.25 }, { height: 256, vector_budget: 512, width: 512 }, vectorStyle)).toBeNull();
  });
});
