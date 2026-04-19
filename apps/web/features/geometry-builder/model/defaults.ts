/**
 * P1 — Default primitive parameters factory.
 *
 * Produces sensible, universe-aware defaults for each primitive kind.
 */

import type {
  PrimitiveKind,
  PrimitiveParams,
  BoxParams,
  CylinderParams,
  SphereParams,
  DiskParams,
  TriangularPrismParams,
  Vec3,
} from "./types";

/** Scale-safe fraction of universe size used for default primitive sizing. */
const DEFAULT_SCALE_FRACTION = 0.25;

function uniformSize(universeSize: Vec3, fraction: number): number {
  const minDim = Math.min(...universeSize);
  return minDim * fraction;
}

export function defaultBoxParams(universeSize: Vec3): BoxParams {
  const s = uniformSize(universeSize, DEFAULT_SCALE_FRACTION);
  return { size: [s, s, s] };
}

export function defaultCylinderParams(universeSize: Vec3): CylinderParams {
  const s = uniformSize(universeSize, DEFAULT_SCALE_FRACTION);
  return { radius: s / 2, height: s, axis: "z" };
}

export function defaultSphereParams(universeSize: Vec3): SphereParams {
  const s = uniformSize(universeSize, DEFAULT_SCALE_FRACTION);
  return { radius: s / 2 };
}

export function defaultDiskParams(universeSize: Vec3): DiskParams {
  const s = uniformSize(universeSize, DEFAULT_SCALE_FRACTION);
  return { radius: s / 2, thickness: s * 0.1, axis: "z" };
}

export function defaultTriangularPrismParams(universeSize: Vec3): TriangularPrismParams {
  const s = uniformSize(universeSize, DEFAULT_SCALE_FRACTION);
  return { base: s, triangleHeight: s, depth: s, axis: "z" };
}

export function defaultPrimitiveParams(
  kind: PrimitiveKind,
  universeSize: Vec3,
): PrimitiveParams {
  switch (kind) {
    case "box":
      return { kind: "box", data: defaultBoxParams(universeSize) };
    case "cylinder":
      return { kind: "cylinder", data: defaultCylinderParams(universeSize) };
    case "sphere":
      return { kind: "sphere", data: defaultSphereParams(universeSize) };
    case "disk":
      return { kind: "disk", data: defaultDiskParams(universeSize) };
    case "triangular_prism":
      return { kind: "triangular_prism", data: defaultTriangularPrismParams(universeSize) };
  }
}
