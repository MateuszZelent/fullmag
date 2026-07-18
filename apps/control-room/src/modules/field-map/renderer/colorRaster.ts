import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";

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
  return Number.isFinite(min) ? { max, min } : null;
}

export function colorizeScalarRaster(
  values: ArrayLike<number>,
  range: ColorRange,
  mask?: ArrayLike<number>,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(values.length * 4);
  const span = range.max - range.min || 1;
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    const value = values[index] ?? Number.NaN;
    if (!isRenderablePlanarOccupancy(mask?.[index]) || !Number.isFinite(value)) continue;
    const t = Math.max(0, Math.min(1, (value - range.min) / span));
    pixels[offset] = Math.round(255 * t);
    pixels[offset + 1] = Math.round(255 * (1 - Math.abs(2 * t - 1)));
    pixels[offset + 2] = Math.round(255 * (1 - t));
    pixels[offset + 3] = 255;
  }
  return pixels;
}
