import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";
import { directionHslSrgb } from "@/shared/visualization/directionColor";
import { scalarColorSrgb } from "@/shared/visualization/scalarColorPalette";

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
      const [red, green, blue] = scalarColorSrgb(t, options.colormap);
      pixels[offset] = Math.round(255 * red);
      pixels[offset + 1] = Math.round(255 * green);
      pixels[offset + 2] = Math.round(255 * blue);
    }
    pixels[offset + 3] = Math.round(255 * opacity);
  }
  return pixels;
}

/**
 * Colour each occupied pixel by its full vector direction (mumax3 HSL wheel,
 * world frame). `vectors` holds three world components per pixel.
 */
export function colorizeDirectionRaster(
  vectors: ArrayLike<number>,
  mask?: ArrayLike<number>,
  options: { opacity?: number } = {},
): Uint8ClampedArray {
  const opacity = options.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error("Planar raster opacity must be finite and within [0, 1]");
  }
  const count = Math.floor(vectors.length / 3);
  const pixels = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index += 1) {
    const x = vectors[index * 3] ?? Number.NaN;
    const y = vectors[index * 3 + 1] ?? Number.NaN;
    const z = vectors[index * 3 + 2] ?? Number.NaN;
    if (!isRenderablePlanarOccupancy(mask?.[index])) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const [red, green, blue] = directionHslSrgb(x, y, z);
    const offset = index * 4;
    pixels[offset] = Math.round(255 * red);
    pixels[offset + 1] = Math.round(255 * green);
    pixels[offset + 2] = Math.round(255 * blue);
    pixels[offset + 3] = Math.round(255 * opacity);
  }
  return pixels;
}
