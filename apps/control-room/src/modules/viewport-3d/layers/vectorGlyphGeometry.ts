import {
  normalizeViewport3DVectorColorMode,
  resolveViewport3DVectorColorRgb,
  resolveViewport3DVectorColorScalar,
  type Viewport3DScalarColorRange,
  type Viewport3DVectorColorMode,
} from "../viewport3dVectorColoring";

export interface VectorGlyphInstanceOptions {
  colorMode?: string;
  headLengthRatio?: number;
  headRadiusRatio?: number;
  /** Deprecated compatibility flag; vector colors are keyed to physical XYZ. */
  orientationFrame?: "physical" | "hud";
  shaftRadiusRatio?: number;
}

export interface VectorGlyphTransforms {
  count: number;
  directions: Float32Array;
  headCenters: Float32Array;
  headScales: Float32Array;
  shaftCenters: Float32Array;
  shaftScales: Float32Array;
}

export interface VectorGlyphInstances extends VectorGlyphTransforms {
  colors: Float32Array | null;
}

// V1-matched proportions: larger head, thicker shaft for better visibility.
const DEFAULT_HEAD_LENGTH_RATIO = 0.35;
const DEFAULT_HEAD_RADIUS_RATIO = 0.20;
const DEFAULT_SHAFT_RADIUS_RATIO = 0.08;

/**
 * Number of floats per segment in the production format:
 * [sx, sy, sz, ex, ey, ez, relMag].
 *
 * Legacy 6-float segments (no magnitude channel) are still accepted — the
 * glyph geometry will be built correctly and magnitude colouring will fall
 * back to relMag = 1 (full brightness).
 */
const FLOATS_PER_SEGMENT = 7;

export function buildVectorGlyphInstances(
  segments: Float32Array,
  options: VectorGlyphInstanceOptions = {},
): VectorGlyphInstances {
  const transforms = buildVectorGlyphTransforms(segments, options);
  return {
    ...transforms,
    colors: buildVectorGlyphColors(segments, options.colorMode),
  };
}

export function buildVectorGlyphTransforms(
  segments: Float32Array,
  options: VectorGlyphInstanceOptions = {},
): VectorGlyphTransforms {
  // Support both 7-channel (production) and 6-channel (legacy / test) formats.
  const segmentStride = resolveSegmentStride(segments);
  const count = Math.floor(segments.length / segmentStride);
  const headLengthRatio =
    options.headLengthRatio ?? DEFAULT_HEAD_LENGTH_RATIO;
  const headRadiusRatio = options.headRadiusRatio ?? DEFAULT_HEAD_RADIUS_RATIO;
  const shaftRadiusRatio =
    options.shaftRadiusRatio ?? DEFAULT_SHAFT_RADIUS_RATIO;
  const directions = new Float32Array(count * 3);
  const headCenters = new Float32Array(count * 3);
  const headScales = new Float32Array(count * 3);
  const shaftCenters = new Float32Array(count * 3);
  const shaftScales = new Float32Array(count * 3);

  for (let vector = 0; vector < count; vector += 1) {
    const source = vector * segmentStride;
    const target = vector * 3;
    const sx = segments[source] ?? 0;
    const sy = segments[source + 1] ?? 0;
    const sz = segments[source + 2] ?? 0;
    const ex = segments[source + 3] ?? sx;
    const ey = segments[source + 4] ?? sy;
    const ez = segments[source + 5] ?? sz;
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const length = Math.hypot(dx, dy, dz);
    const ux = length > 0 ? dx / length : 0;
    const uy = length > 0 ? dy / length : 1;
    const uz = length > 0 ? dz / length : 0;
    const headLength = length * headLengthRatio;
    const shaftLength = Math.max(length - headLength, 0);
    const shaftRadius = length * shaftRadiusRatio;
    const headRadius = length * headRadiusRatio;

    directions[target] = ux;
    directions[target + 1] = uy;
    directions[target + 2] = uz;

    shaftCenters[target] = sx + ux * (shaftLength / 2);
    shaftCenters[target + 1] = sy + uy * (shaftLength / 2);
    shaftCenters[target + 2] = sz + uz * (shaftLength / 2);

    headCenters[target] = sx + ux * (shaftLength + headLength / 2);
    headCenters[target + 1] = sy + uy * (shaftLength + headLength / 2);
    headCenters[target + 2] = sz + uz * (shaftLength + headLength / 2);

    shaftScales[target] = shaftRadius;
    shaftScales[target + 1] = shaftLength;
    shaftScales[target + 2] = shaftRadius;

    headScales[target] = headRadius;
    headScales[target + 1] = headLength;
    headScales[target + 2] = headRadius;
  }

  return {
    count,
    directions,
    headCenters,
    headScales,
    shaftCenters,
    shaftScales,
  };
}

export function buildVectorGlyphColors(
  segments: Float32Array,
  colorModeValue?: string,
): Float32Array | null {
  const segmentStride = resolveSegmentStride(segments);
  const count = Math.floor(segments.length / segmentStride);
  const colorMode = normalizeViewport3DVectorColorMode(colorModeValue);
  if (colorMode === "monochrome") return null;

  const colors = new Float32Array(count * 3);
  const colorRange = resolveSegmentColorRange(
    segments,
    count,
    segmentStride,
    colorMode,
  );

  for (let vector = 0; vector < count; vector += 1) {
    const source = vector * segmentStride;
    const target = vector * 3;
    const sx = segments[source] ?? 0;
    const sy = segments[source + 1] ?? 0;
    const sz = segments[source + 2] ?? 0;
    const dx = (segments[source + 3] ?? sx) - sx;
    const dy = (segments[source + 4] ?? sy) - sy;
    const dz = (segments[source + 5] ?? sz) - sz;
    const relMag = segmentStride >= 7 ? (segments[source + 6] ?? 1) : 1;
    const rgb = resolveViewport3DVectorColorRgb(
      colorMode,
      dx,
      dy,
      dz,
      colorRange,
      relMag,
    );
    if (!rgb) continue;
    colors[target] = rgb[0] ?? 0;
    colors[target + 1] = rgb[1] ?? 0;
    colors[target + 2] = rgb[2] ?? 0;
  }

  return colors;
}

function resolveSegmentStride(segments: Float32Array): number {
  return segments.length > 0 && segments.length % FLOATS_PER_SEGMENT === 0
    ? FLOATS_PER_SEGMENT
    : 6;
}

function resolveSegmentColorRange(
  segments: Float32Array,
  count: number,
  segmentStride: number,
  colorMode: Viewport3DVectorColorMode,
): Viewport3DScalarColorRange {
  // Magnitude coloring uses the pre-normalised relMag channel directly
  // (range is always [0, 1]).
  if (colorMode === "magnitude") {
    return { min: 0, max: 1 };
  }

  // x / y / z: symmetric range so that 0 maps to the neutral colour.
  if (colorMode === "x" || colorMode === "y" || colorMode === "z") {
    let maxAbs = 0;
    for (let vector = 0; vector < count; vector += 1) {
      const source = vector * segmentStride;
      const dx = (segments[source + 3] ?? 0) - (segments[source] ?? 0);
      const dy = (segments[source + 4] ?? 0) - (segments[source + 1] ?? 0);
      const dz = (segments[source + 5] ?? 0) - (segments[source + 2] ?? 0);
      const value = Math.abs(
        resolveViewport3DVectorColorScalar(
          colorMode,
          dx,
          dy,
          dz,
        ),
      );
      if (value > maxAbs) maxAbs = value;
    }
    const range = Math.max(maxAbs, 1e-12);
    return { min: -range, max: range };
  }

  // orientation: range not used, return identity.
  return { min: 0, max: 1 };
}
