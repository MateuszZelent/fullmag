import { describe, expect, it } from "vitest";

import { activePlanarComponentPreset, planarComponentPresetPatch } from "./planarComponentPresets";

describe("2D toolbar component presets", () => {
  it("colours by direction while keeping the scalar magnitude for contours and probes", () => {
    expect(planarComponentPresetPatch("direction", null)).toEqual({
      colormap: "hsl_direction",
      component: "magnitude",
    });
  });

  it("uses a symmetric diverging range for Cartesian components unless the range is manual", () => {
    expect(planarComponentPresetPatch("z", { max: null, min: null, mode: "auto" })).toEqual({
      colormap: "coolwarm",
      component: "z",
      range: { max: null, min: null, mode: "symmetric" },
    });
    expect(planarComponentPresetPatch("z", { max: 1, min: -1, mode: "manual" })).toEqual({
      colormap: "coolwarm",
      component: "z",
    });
  });

  it("recovers the active preset from the profile", () => {
    expect(activePlanarComponentPreset({ colormap: "hsl_direction", component: "magnitude" })).toBe("direction");
    expect(activePlanarComponentPreset({ colormap: "coolwarm", component: "y" })).toBe("y");
    expect(activePlanarComponentPreset({ colormap: "viridis", component: "orientation" })).toBeNull();
  });
});
