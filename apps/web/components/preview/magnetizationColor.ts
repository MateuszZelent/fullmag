import * as THREE from "three";

function positiveModulo(value: number, modulus: number): number {
  let result = value % modulus;
  if (result < 0) {
    result += modulus;
  }
  return result;
}

function orientationHsvToRgb(hRadians: number, s: number, v: number, color: THREE.Color): THREE.Color {
  const saturation = THREE.MathUtils.clamp(s, 0, 1);
  const value = THREE.MathUtils.clamp(v, 0, 1);
  const h = positiveModulo((hRadians * 180) / Math.PI / 60, 6);

  const c = value * saturation;
  const x = c * (1 - Math.abs(positiveModulo(h, 2) - 1));
  const m = value - c;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 1) {
    r = c;
    g = x;
  } else if (h < 2) {
    r = x;
    g = c;
  } else if (h < 3) {
    g = c;
    b = x;
  } else if (h < 4) {
    g = x;
    b = c;
  } else if (h < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return color.setRGB(r + m, g + m, b + m);
}

/**
 * Orientation-sphere coloring used by the viewport:
 * - normalize the vector first, so color depends on direction rather than length
 * - hue comes from the in-plane angle atan2(my, mx)
 * - saturation comes from the in-plane radius sqrt(mx^2 + my^2)
 * - value comes from mz via 0.5 * mz + 0.5
 *
 * This gives the expected sphere semantics:
 * - +X = red
 * - XY plane = vivid hues
 * - +Z = white at the pole, not across the whole upper hemisphere
 * - -Z = black at the pole
 *
 * In other words, H tracks azimuth, S tracks how much of the vector stays
 * in-plane, and V tracks out-of-plane sign and amplitude.
 */
export function applyMagnetizationHsl(
  mx: number,
  my: number,
  mz: number,
  color: THREE.Color,
): THREE.Color {
  const magnitude = Math.sqrt(mx * mx + my * my + mz * mz);
  if (magnitude <= 1e-30) {
    return color.setHSL(0, 0, 0.6);
  }
  const nx = mx / magnitude;
  const ny = my / magnitude;
  const nz = mz / magnitude;
  const hueRadians = Math.atan2(ny, nx);
  const saturation = THREE.MathUtils.clamp(Math.sqrt(nx * nx + ny * ny), 0, 1);
  const value = THREE.MathUtils.clamp(nz * 0.5 + 0.5, 0, 1);
  return orientationHsvToRgb(hueRadians, saturation, value, color);
}

export function magnetizationHslColor(mx: number, my: number, mz: number): THREE.Color {
  return applyMagnetizationHsl(mx, my, mz, new THREE.Color());
}
