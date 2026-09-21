/**
 * Colour-space helpers for viewport-3D GPU buffers.
 *
 * `configureViewport3DRenderer` (viewport3dVisualProfile.ts) sets
 * `renderer.outputColorSpace = SRGBColorSpace`, so three.js works in
 * Linear-sRGB and applies the sRGB transfer function once, on output.
 *
 * Buffer attributes named `color` and `instanceColor` carry no colour-space
 * metadata: three.js reads them as values already in the working space, i.e.
 * as **linear**. Every colour this module's callers produce -- the HSL sphere
 * in orientation/magnetizationColor.ts, the scalar palettes in
 * shared/visualization/scalarColorPalette.ts -- is authored in **sRGB**.
 * Uploading those code values unconverted applies the transfer function a
 * second time and lifts every mid-tone towards white:
 *
 *   tilt out of plane |  intended colour  |  what unconverted upload showed
 *              5 deg  |  1.000 0.087 0.087 |  1.000 0.327 0.327
 *             10 deg  |  1.000 0.174 0.174 |  1.000 0.454 0.454
 *             30 deg  |  1.000 0.500 0.500 |  1.000 0.735 0.735
 *
 * The lift is also asymmetric about the equator: below it the green and blue
 * channels are zero and stay zero, so -Z kept its saturation while +Z washed
 * out. That is why the two poles looked nothing like each other.
 *
 * The surface shaders do the same conversion in GLSL (`srgbToLinearVec3`
 * followed by `#include <colorspace_fragment>`), so CPU-built vertex colours
 * and shader-computed surface colours only agree when both convert.
 */

/** sRGB electro-optical transfer function: one sRGB channel -> linear. */
export function srgbToLinearChannel(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Inverse of {@link srgbToLinearChannel}; for colours headed back to CSS. */
export function linearToSrgbChannel(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** sRGB triple -> linear-sRGB triple, ready for a three.js colour attribute. */
export function srgbToLinearRgb(
  rgb: readonly [number, number, number],
): [number, number, number] {
  return [
    srgbToLinearChannel(rgb[0]),
    srgbToLinearChannel(rgb[1]),
    srgbToLinearChannel(rgb[2]),
  ];
}
