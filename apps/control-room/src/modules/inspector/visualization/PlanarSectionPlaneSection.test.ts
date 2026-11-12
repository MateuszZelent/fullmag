import { describe, expect, it } from "vitest";

import type { PlanarSectionGeometry } from "@/kernel/visualization/planarSectionModel";

import { sectionFractionFromNanometres } from "./PlanarSectionPlaneSection";
import { planarCropFromEdit } from "./PlanarCropViewSection";

const geometry = {
  plane: "xy", normal: "z", u: "x", v: "y",
  normalMin: -10e-9, normalMax: 30e-9, normalExtent: 40e-9,
  layerCount: null, layerSpacing: null, nativeResolution: null,
} as PlanarSectionGeometry;

describe("2D section and crop inputs", () => {
  it("converts nm to a clamped slice fraction", () => {
    expect(sectionFractionFromNanometres("10", geometry)).toBeCloseTo(0.5, 12);
    expect(sectionFractionFromNanometres("-50", geometry)).toBe(0);
    expect(sectionFractionFromNanometres("90", geometry)).toBe(1);
    expect(sectionFractionFromNanometres("abc", geometry)).toBeNull();
    expect(sectionFractionFromNanometres("", geometry)).toBeNull();
  });

  it("validates one crop limit against the other three", () => {
    const base = { u_min_m: -25e-9, u_max_m: 25e-9, v_min_m: -30e-9, v_max_m: 30e-9 };
    const edited = planarCropFromEdit(base, "v_max_m", "10");
    expect("crop" in edited && edited.crop.v_max_m).toBeCloseTo(10e-9);
    expect(planarCropFromEdit(base, "u_min_m", "25")).toEqual({ error: "Minimum must be below the maximum." });
    expect(planarCropFromEdit(base, "v_max_m", "-40")).toEqual({ error: "Maximum must be above the minimum." });
    expect(planarCropFromEdit(base, "u_max_m", "x")).toEqual({ error: "Enter a finite value in nm." });
  });
});
