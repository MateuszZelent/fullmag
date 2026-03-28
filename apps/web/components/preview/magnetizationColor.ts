import * as THREE from "three";

/**
 * Mumax3 viewer orientation coloring:
 * - normalize m
 * - hue from atan2(my, mx)
 * - saturation fixed at 1
 * - lightness from mz via 0.5 + 0.5 * mz
 *
 * The poles are still neutral because HSL collapses to white/black at L=1/0.
 * Our previous clamp of lightness to <1 made +Z incorrectly appear pastel pink.
 *
 * Reference:
 * https://github.com/JeroenMulkers/mumax-view/blob/master/src/shaders.hpp
 */
export function applyMagnetizationHsl(
  mx: number,
  my: number,
  mz: number,
  color: THREE.Color,
): THREE.Color {
  const magnitude = Math.sqrt(mx * mx + my * my + mz * mz);
  if (magnitude <= 1e-30) {
    return color.setRGB(0, 0, 0);
  }
  const nx = mx / magnitude;
  const ny = my / magnitude;
  const nz = mz / magnitude;
  const hue = Math.atan2(ny, nx) / (Math.PI * 2);
  const lightness = THREE.MathUtils.clamp(nz * 0.5 + 0.5, 0, 1);
  return color.setHSL((hue + 1) % 1, 1, lightness);
}

export function magnetizationHslColor(mx: number, my: number, mz: number): THREE.Color {
  return applyMagnetizationHsl(mx, my, mz, new THREE.Color());
}
