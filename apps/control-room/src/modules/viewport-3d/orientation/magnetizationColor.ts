import { srgbToLinearRgb } from "../viewport3dColorSpace";
import {
  DIRECTION_HSL_NEUTRAL_RGB,
  DIRECTION_HSL_SATURATION,
  DIRECTION_HSL_ZERO_NORM,
  directionHslSrgb,
} from "@/shared/visualization/directionColor";

/**
 * Saturation of the HSL sphere.
 *
 * Deliberately a constant. This is a *direction* colormap: the polar angle is
 * already carried by the lightness, and |m| carries the field's units, not its
 * orientation. Vectors with no meaningful direction are handled by the
 * near-zero guard and by `isLowConfidenceOrientationVector` in
 * viewport3dFieldMapping.ts.
 */
export const MAGNETIZATION_HSL_SATURATION = DIRECTION_HSL_SATURATION;

/** Below this norm a vector has no direction to speak of. */
export const MAGNETIZATION_HSL_ZERO_NORM = DIRECTION_HSL_ZERO_NORM;

/** Colour used where the vector carries no usable direction. */
export const MAGNETIZATION_HSL_NEUTRAL_RGB = DIRECTION_HSL_NEUTRAL_RGB;

/**
 * mumax3-style HSL sphere for a magnetisation direction; the 2D field map uses
 * the same shared function (see `shared/visualization/directionColor.ts`).
 *
 * Returns **sRGB** components in [0, 1], which is what CSS wants. For three.js
 * `color` / `instanceColor` attributes use {@link magnetizationHslLinearRgb} --
 * see viewport3dColorSpace.ts for why the distinction matters.
 */
export function magnetizationHslRgb(
  mx: number,
  my: number,
  mz: number,
): [number, number, number] {
  return directionHslSrgb(mx, my, mz);
}

/**
 * {@link magnetizationHslRgb} in linear-sRGB, for three.js colour attributes.
 */
export function magnetizationHslLinearRgb(
  mx: number,
  my: number,
  mz: number,
): [number, number, number] {
  return srgbToLinearRgb(magnetizationHslRgb(mx, my, mz));
}

export const HSL_REFERENCE_AXES = [
  {
    color: magnetizationHslRgb(1, 0, 0),
    direction: [1, 0, 0],
    id: "x",
    label: "+X",
  },
  {
    color: magnetizationHslRgb(0, 1, 0),
    direction: [0, 1, 0],
    id: "y",
    label: "+Y",
  },
  {
    color: magnetizationHslRgb(0, 0, 1),
    direction: [0, 0, 1],
    id: "z",
    label: "+Z",
  },
] satisfies Array<{
  color: [number, number, number];
  direction: [number, number, number];
  id: string;
  label: string;
}>;
