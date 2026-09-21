import { srgbToLinearRgb } from "../viewport3dColorSpace";
import { clampNumber } from "../viewport3dMath";

/**
 * Saturation of the HSL sphere.
 *
 * Deliberately a constant. This is a *direction* colormap: the polar angle is
 * already carried by the lightness, and |m| carries the field's units, not its
 * orientation. Folding |m| in (the previous behaviour) meant A/m data sat
 * permanently clamped at 1 while small-amplitude eigenmodes rendered as a flat
 * grey. Vectors with no meaningful direction are handled by the near-zero
 * guard below and by `isLowConfidenceOrientationVector` in
 * viewport3dFieldMapping.ts.
 */
export const MAGNETIZATION_HSL_SATURATION = 1;

/** Below this norm a vector has no direction to speak of. */
const MAGNETIZATION_HSL_ZERO_NORM = 1e-30;

/** Colour used where the vector carries no usable direction. */
const MAGNETIZATION_HSL_NEUTRAL_RGB: [number, number, number] = [0.6, 0.6, 0.6];

/**
 * mumax3-style HSL sphere for a magnetisation direction.
 *
 *   hue        = atan2(m̂y, m̂x)    -- in-plane angle
 *   saturation = MAGNETIZATION_HSL_SATURATION
 *   lightness  = 0.5 · m̂z + 0.5    -- -Z black, in-plane 0.5, +Z white
 *
 * Every term is derived from the same normalised direction m̂, so the colour
 * depends only on where the vector points and never on the units the field
 * happens to be stored in.
 *
 * The previous implementation normalised for the hue but fed the RAW `mz` into
 * the lightness. For anything that is not exactly unit length -- A/m data,
 * eigenmode amplitudes, thickness- or face-averaged vectors -- `mz * 0.5 + 0.5`
 * clamps straight to 0 or 1, so a 1 degree tilt out of plane already rendered
 * as pure white (or pure black below the plane) while in-plane vectors still
 * looked correct.
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
  const magnitude = Math.hypot(mx, my, mz);
  if (magnitude <= MAGNETIZATION_HSL_ZERO_NORM) {
    return [...MAGNETIZATION_HSL_NEUTRAL_RGB];
  }

  const nx = mx / magnitude;
  const ny = my / magnitude;
  const nz = mz / magnitude;
  const hueRadians = Math.atan2(ny, nx);
  const lightness = clampNumber(nz * 0.5 + 0.5, 0, 1);
  return orientationHslToRgb(
    hueRadians,
    MAGNETIZATION_HSL_SATURATION,
    lightness,
  );
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

function orientationHslToRgb(
  hueRadians: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  const h = positiveModulo((hueRadians * 180) / Math.PI / 60, 6);
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(positiveModulo(h, 2) - 1));
  const m = lightness - c / 2;

  if (h < 1) return [c + m, x + m, m];
  if (h < 2) return [x + m, c + m, m];
  if (h < 3) return [m, c + m, x + m];
  if (h < 4) return [m, x + m, c + m];
  if (h < 5) return [x + m, m, c + m];
  return [c + m, m, x + m];
}

function positiveModulo(value: number, modulus: number): number {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
}
