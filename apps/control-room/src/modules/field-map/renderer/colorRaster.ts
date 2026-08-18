import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";

export interface ColorRange {
  max: number;
  min: number;
}

export function finiteScalarRange(
  values: ArrayLike<number>,
  mask?: ArrayLike<number>,
): ColorRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (!isRenderablePlanarOccupancy(mask?.[index]) || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) ? { max, min } : { min: 0, max: 0 };
}

export function colorizeScalarRaster(
  values: ArrayLike<number>,
  range: ColorRange,
  mask?: ArrayLike<number>,
  options: { colormap?: string; opacity?: number } = {},
): Uint8ClampedArray {
  const opacity = options.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error("Planar raster opacity must be finite and within [0, 1]");
  }
  const pixels = new Uint8ClampedArray(values.length * 4);
  const span = range.max - range.min;
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    const value = values[index] ?? Number.NaN;
    if (!isRenderablePlanarOccupancy(mask?.[index]) || !Number.isFinite(value)) continue;
    const t = span === 0 ? 0.5 : Math.max(0, Math.min(1, (value - range.min) / span));
    if (options.colormap === "grayscale") {
      const shade = Math.round(255 * t);
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
    } else {
      const [red, green, blue] = scalarColorRgb(t, options.colormap);
      pixels[offset] = Math.round(255 * red);
      pixels[offset + 1] = Math.round(255 * green);
      pixels[offset + 2] = Math.round(255 * blue);
    }
    pixels[offset + 3] = Math.round(255 * opacity);
  }
  return pixels;
}
