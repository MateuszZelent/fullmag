import { magnetizationHslRgb } from "../orientation/magnetizationColor";

export interface VectorGlyphInstanceOptions {
  colorMode?: string;
  headLengthRatio?: number;
  headRadiusRatio?: number;
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

const DEFAULT_HEAD_LENGTH_RATIO = 0.28;
const DEFAULT_HEAD_RADIUS_RATIO = 0.14;
const DEFAULT_SHAFT_RADIUS_RATIO = 0.045;
const FLOATS_PER_SEGMENT = 6;

export function buildVectorGlyphInstances(
  segments: Float32Array,
  options: VectorGlyphInstanceOptions = {},
): VectorGlyphInstances {
  const count = Math.floor(segments.length / FLOATS_PER_SEGMENT);
  const colorMode = options.colorMode ?? "orientation";
  const headLengthRatio =
    options.headLengthRatio ?? DEFAULT_HEAD_LENGTH_RATIO;
  const headRadiusRatio = options.headRadiusRatio ?? DEFAULT_HEAD_RADIUS_RATIO;
  const shaftRadiusRatio =
    options.shaftRadiusRatio ?? DEFAULT_SHAFT_RADIUS_RATIO;
  const colors =
    colorMode === "orientation" ? new Float32Array(count * 3) : null;
  const directions = new Float32Array(count * 3);
  const headCenters = new Float32Array(count * 3);
  const headScales = new Float32Array(count * 3);
  const shaftCenters = new Float32Array(count * 3);
  const shaftScales = new Float32Array(count * 3);

  for (let vector = 0; vector < count; vector += 1) {
    const source = vector * FLOATS_PER_SEGMENT;
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

    if (colors) {
      colors.set(magnetizationHslRgb(dx, dy, dz), target);
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
