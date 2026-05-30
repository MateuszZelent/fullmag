import type { DecodedCrossSection } from "@/kernel/api/codecs";

export function resolveViewport2DFrameRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampNumber(value, -180, 180);
}

export function rotateViewport2DPositions(
  positions: Float32Array,
  bounds: DecodedCrossSection["bounds"],
  rotationDegrees: number,
): void {
  if (rotationDegrees === 0) return;

  const transform = frameTransform(bounds, rotationDegrees);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 3;
    const rotated = rotatePoint(
      positions[offset],
      positions[offset + 1],
      transform,
    );
    positions[offset] = rotated.u;
    positions[offset + 1] = rotated.v;
  }
}

export function rotateViewport2DSegments(
  segments: Float32Array,
  bounds: DecodedCrossSection["bounds"],
  rotationDegrees: number,
): Float32Array {
  if (rotationDegrees === 0) return segments;

  const rotated = new Float32Array(segments.length);
  const transform = frameTransform(bounds, rotationDegrees);
  for (let index = 0; index < segments.length; index += 4) {
    const first = rotatePoint(segments[index], segments[index + 1], transform);
    const second = rotatePoint(
      segments[index + 2],
      segments[index + 3],
      transform,
    );
    rotated[index] = first.u;
    rotated[index + 1] = first.v;
    rotated[index + 2] = second.u;
    rotated[index + 3] = second.v;
  }
  return rotated;
}

export function summarizeViewport2DPositionBounds(
  positions: Float32Array,
  fallback: DecodedCrossSection["bounds"],
): DecodedCrossSection["bounds"] {
  if (positions.length === 0) return fallback;

  let uMin = Number.POSITIVE_INFINITY;
  let uMax = Number.NEGATIVE_INFINITY;
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 3;
    const u = positions[offset];
    const v = positions[offset + 1];
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  return { uMax, uMin, vMax, vMin };
}

interface FrameTransform {
  centerU: number;
  centerV: number;
  cos: number;
  sin: number;
}

function frameTransform(
  bounds: DecodedCrossSection["bounds"],
  rotationDegrees: number,
): FrameTransform {
  const rotation = (rotationDegrees * Math.PI) / 180;
  return {
    centerU: (bounds.uMin + bounds.uMax) / 2,
    centerV: (bounds.vMin + bounds.vMax) / 2,
    cos: Math.cos(rotation),
    sin: Math.sin(rotation),
  };
}

function rotatePoint(
  u: number,
  v: number,
  transform: FrameTransform,
): { u: number; v: number } {
  const offsetU = u - transform.centerU;
  const offsetV = v - transform.centerV;
  return {
    u: transform.centerU + offsetU * transform.cos - offsetV * transform.sin,
    v: transform.centerV + offsetU * transform.sin + offsetV * transform.cos,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
