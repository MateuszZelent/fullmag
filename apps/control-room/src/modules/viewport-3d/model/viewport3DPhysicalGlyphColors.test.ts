import { describe, expect, it } from "vitest";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";
import type { Viewport3DFieldVector } from "../viewport3dFieldMapping";
import { buildViewport3DPhysicalGlyphColors } from "./viewport3DPhysicalGlyphColors";

function field(values: number[], quantityId = "H_demag"): Viewport3DFieldVector {
  return { quantityId, nComp: 3, pointCount: values.length / 3, dtype: "float64", values: new Float64Array(values) } as Viewport3DFieldVector;
}

describe("physical FEM glyph colors", () => {
  it("colors emitted scoped samples by physical magnitude and the same range as the legend", () => {
    const result = buildViewport3DPhysicalGlyphColors({
      field: field([3, 4, 0, 0, 0, 10]), sampleIndices: new Uint32Array([1, 0]),
      colorMode: "magnitude", palette: "plasma", range: { min: 5, max: 10 },
    });
    expect(result?.scale).toEqual({ quantityId: "H_demag", colorMode: "magnitude", colorPalette: "plasma", range: { min: 5, max: 10 } });
    expect(result?.colors).toEqual(new Float32Array([...scalarColorRgb(1, "plasma"), ...scalarColorRgb(0, "plasma")]));
  });

  it("invalidates palette colors without changing quantity or source samples", () => {
    const source = field([1, 0, 0, 2, 0, 0], "m");
    const input = { field: source, sampleIndices: new Uint32Array([0, 1]), colorMode: "magnitude" };
    const first = buildViewport3DPhysicalGlyphColors({ ...input, palette: "viridis" });
    const changed = buildViewport3DPhysicalGlyphColors({ ...input, palette: "grayscale" });
    expect(changed?.colors).not.toEqual(first?.colors);
    expect(changed?.scale.quantityId).toBe("m");
    expect(changed?.scale.range).toEqual(first?.scale.range);
    expect(buildViewport3DPhysicalGlyphColors({ ...input, palette: "grayscale" })).toBe(changed);
  });

  it("uses signed physical components and symmetric diverging ranges", () => {
    const result = buildViewport3DPhysicalGlyphColors({
      field: field([-2, 100, 0, 4, 1, 0]), sampleIndices: new Uint32Array([0, 1]),
      colorMode: "x", palette: "rdbu",
    });
    expect(result?.scale.range).toEqual({ min: -4, max: 4 });
    expect(result?.colors).toEqual(new Float32Array([...scalarColorRgb(.25, "rdbu"), ...scalarColorRgb(1, "rdbu")]));
  });

  it("retains direction/monochrome semantics and refuses unmapped nodes", () => {
    const input = { field: field([1, 0, 0]), sampleIndices: new Uint32Array([0]), palette: "turbo" };
    expect(buildViewport3DPhysicalGlyphColors({ ...input, colorMode: "orientation" })).toBeNull();
    expect(buildViewport3DPhysicalGlyphColors({ ...input, colorMode: "monochrome" })).toBeNull();
    expect(buildViewport3DPhysicalGlyphColors({ ...input, colorMode: "magnitude", sampleIndices: new Uint32Array([2]) })).toBeNull();
  });
});
