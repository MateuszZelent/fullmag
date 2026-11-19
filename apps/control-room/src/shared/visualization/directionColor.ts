/**
 * mumax3-style HSL direction colormap, shared by the 2D and 3D viewports so
 * one vector has one colour everywhere.
 *
 *   hue        = atan2(v̂y, v̂x)   -- world in-plane angle (+X red, +Y yellow-green)
 *   saturation = 1
 *   lightness  = 0.5 · v̂z + 0.5   -- -Z black, in-plane 0.5, +Z white
 *
 * Every term uses the normalised direction v̂, so the colour does not depend on
 * the unit or amplitude of the field. Vectors without a usable direction map
 * to a neutral grey instead of NaN (mumax3 divides by a zero maximum there).
 *
 * Returns sRGB components in [0, 1].
 */
export const DIRECTION_HSL_SATURATION = 1;

/** Below this norm a vector has no direction to speak of. */
export const DIRECTION_HSL_ZERO_NORM = 1e-30;

/** Colour used where the vector carries no usable direction. */
export const DIRECTION_HSL_NEUTRAL_RGB: readonly [number, number, number] = [0.6, 0.6, 0.6];

/** Planar colormap id that colours the raster by the full vector direction. */
export const DIRECTION_COLORMAP = "hsl_direction";

export function isDirectionColormap(colormap: string | null | undefined): boolean {
  return colormap === DIRECTION_COLORMAP;
}

export function directionHslSrgb(x: number, y: number, z: number): [number, number, number] {
  const magnitude = Math.hypot(x, y, z);
  if (!(magnitude > DIRECTION_HSL_ZERO_NORM)) {
    return [...DIRECTION_HSL_NEUTRAL_RGB];
  }
  const nz = z / magnitude;
  const lightness = Math.min(1, Math.max(0, nz * 0.5 + 0.5));
  return hslToSrgb(Math.atan2(y / magnitude, x / magnitude), DIRECTION_HSL_SATURATION, lightness);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function hslToSrgb(
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
