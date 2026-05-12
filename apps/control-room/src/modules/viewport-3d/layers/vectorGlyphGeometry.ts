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
  orientationFrame?: "physical" | "hud";
  shaftRadiusRatio?: number;
}

export interface VectorGlyphInstances {
  colors: Float32Array | null;
  count: number;
  directions: Float32Array;
  headCenters: Float32Array;
  headScales: Float32Array;
  shaftCenters: Float32Array;
  shaftScales: Float32Array;
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
  // Support both 7-channel (production) and 6-channel (legacy / test) formats.
  const segmentStride =
    segments.length > 0 && segments.length % FLOATS_PER_SEGMENT === 0
      ? FLOATS_PER_SEGMENT
      : 6;
  const count = Math.floor(segments.length / segmentStride);
  const colorMode = normalizeViewport3DVectorColorMode(options.colorMode);
  const orientationFrame = options.orientationFrame ?? "physical";
  const headLengthRatio =
    options.headLengthRatio ?? DEFAULT_HEAD_LENGTH_RATIO;
  const headRadiusRatio = options.headRadiusRatio ?? DEFAULT_HEAD_RADIUS_RATIO;
  const shaftRadiusRatio =
    options.shaftRadiusRatio ?? DEFAULT_SHAFT_RADIUS_RATIO;
  const colors =
    colorMode !== "monochrome"
      ? new Float32Array(count * 3)
      : null;
  const colorRange = colors
    ? resolveSegmentColorRange(
        segments,
        count,
        segmentStride,
        colorMode,
        orientationFrame,
      )
    : null;
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
    const relMag = segmentStride >= 7 ? (segments[source + 6] ?? 1) : 1;
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const [colorDx, colorDy, colorDz] = resolveOrientationFrameVector(
      dx,
      dy,
      dz,
      orientationFrame,
    );
    const length = Math.hypot(dx, dy, dz);
    const ux = length > 0 ? dx / length : 0;
    const uy = length > 0 ? dy / length : 1;
    const uz = length > 0 ? dz / length : 0;
    const headLength = length * headLengthRatio;
    const shaftLength = Math.max(length - headLength, 0);
    const shaftRadius = length * shaftRadiusRatio;
    const headRadius = length * headRadiusRatio;

    directions.set([ux, uy, uz], target);
    shaftCenters.set(
      [
        sx + ux * (shaftLength / 2),
        sy + uy * (shaftLength / 2),
        sz + uz * (shaftLength / 2),
      ],
      target,
    );
    headCenters.set(
      [
        sx + ux * (shaftLength + headLength / 2),
        sy + uy * (shaftLength + headLength / 2),
        sz + uz * (shaftLength + headLength / 2),
      ],
      target,
    );
    shaftScales.set([shaftRadius, shaftLength, shaftRadius], target);
    headScales.set([headRadius, headLength, headRadius], target);

    if (colors && colorRange) {
      const rgb = resolveViewport3DVectorColorRgb(
        colorMode,
        colorDx,
        colorDy,
        colorDz,
        colorRange,
        relMag,
      );
      if (rgb) colors.set(rgb, target);
    }
  }

  return {
    colors,
    count,
    directions,
    headCenters,
    headScales,
    shaftCenters,
    shaftScales,
  };
}

function resolveSegmentColorRange(
  segments: Float32Array,
  count: number,
  segmentStride: number,
  colorMode: Viewport3DVectorColorMode,
  orientationFrame: NonNullable<VectorGlyphInstanceOptions["orientationFrame"]>,
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
      const [colorDx, colorDy, colorDz] = resolveOrientationFrameVector(
        dx,
        dy,
        dz,
        orientationFrame,
      );
      const value = Math.abs(
        resolveViewport3DVectorColorScalar(
          colorMode,
          colorDx,
          colorDy,
          colorDz,
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

function resolveOrientationFrameVector(
  dx: number,
  dy: number,
  dz: number,
  orientationFrame: NonNullable<VectorGlyphInstanceOptions["orientationFrame"]>,
): [number, number, number] {
  if (orientationFrame === "hud") return [dx, dy, -dz];
  return [dx, dy, dz];
}
