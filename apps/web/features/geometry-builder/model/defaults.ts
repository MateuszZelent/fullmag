/**
 * P1 — Default primitive parameters factory.
 *
 * Produces sensible, universe-aware defaults for each primitive kind.
 * All returned length values are in SI metres.
 *
 * Sizing rule:
 *   targetSize = clamp(min(universeSize) × 0.25, MIN_DEFAULT_SIZE_M, MAX_DEFAULT_SIZE_M)
 * Fallback when Universe is invalid (any dimension ≤ 0):
 *   targetSize = MAX_DEFAULT_SIZE_M  (200 nm)
 */

import { nanoid } from "nanoid";
import type {
  PrimitiveKind,
  PrimitiveParams,
  BoxParams,
  CylinderParams,
  SphereParams,
  EllipsoidParams,
  DiskParams,
  TriangularPrismParams,
  ConeParams,
  CapsuleParams,
  TubeParams,
  WedgeParams,
  PolygonPrismParams,
  PrimitiveNode,
  UniverseNode,
  Vec3,
  Transform3D,
} from "./types";
import { IDENTITY_TRANSFORM } from "./types";

// ── Size constants (SI metres) ────────────────────────────────

/** Minimum default primitive size: 20 nm. */
export const MIN_DEFAULT_SIZE_M = 20e-9;

/** Maximum / fallback default primitive size: 200 nm. */
export const MAX_DEFAULT_SIZE_M = 200e-9;

/** Fraction of Universe minimum dimension used as a starting size estimate. */
const DEFAULT_SCALE_FRACTION = 0.25;

/** Primitive display names used to generate deterministic labels. */
const PRIMITIVE_DISPLAY_NAMES: Record<PrimitiveKind, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  ellipsoid: "Ellipsoid",
  disk: "Disk",
  thin_film: "Thin Film",
  pillar: "Pillar",
  nanowire: "Nanowire",
  ring: "Ring",
  triangular_prism: "Triangular Prism",
  cone: "Cone",
  capsule: "Capsule",
  tube: "Tube",
  wedge: "Wedge",
  polygon_prism: "Polygon Prism",
};

// ── Size computation ──────────────────────────────────────────

/**
 * Returns a sensible scalar target size for a primitive given the Universe.
 * Result is clamped to [MIN_DEFAULT_SIZE_M, MAX_DEFAULT_SIZE_M].
 */
export function defaultTargetSize(universeSize: Vec3): number {
  const minDim = Math.min(...universeSize);
  if (!Number.isFinite(minDim) || minDim <= 0) {
    return MAX_DEFAULT_SIZE_M;
  }
  const raw = minDim * DEFAULT_SCALE_FRACTION;
  return Math.min(Math.max(raw, MIN_DEFAULT_SIZE_M), MAX_DEFAULT_SIZE_M);
}

// ── Per-kind default params ───────────────────────────────────

export function defaultBoxParams(universeSize: Vec3): BoxParams {
  const s = defaultTargetSize(universeSize);
  return { size: [s, s, s] };
}

export function defaultCylinderParams(universeSize: Vec3): CylinderParams {
  const s = defaultTargetSize(universeSize);
  return { radius: s / 2, height: s, axis: "z" };
}

export function defaultSphereParams(universeSize: Vec3): SphereParams {
  const s = defaultTargetSize(universeSize);
  return { radius: s / 2 };
}

export function defaultEllipsoidParams(universeSize: Vec3): EllipsoidParams {
  const s = defaultTargetSize(universeSize);
  return { radii: [s / 2, s / 3, s / 4] };
}

export function defaultDiskParams(universeSize: Vec3): DiskParams {
  const s = defaultTargetSize(universeSize);
  return { radius: s / 2, thickness: Math.max(s * 0.1, 1e-9), axis: "z" };
}

export function defaultTriangularPrismParams(universeSize: Vec3): TriangularPrismParams {
  const s = defaultTargetSize(universeSize);
  return { base: s, triangleHeight: s, depth: s, axis: "z" };
}

export function defaultConeParams(universeSize: Vec3): ConeParams {
  const s = defaultTargetSize(universeSize);
  return { radiusTop: 0, radiusBottom: s / 2, height: s, axis: "z" };
}

export function defaultCapsuleParams(universeSize: Vec3): CapsuleParams {
  const s = defaultTargetSize(universeSize);
  return { radius: s / 4, height: s, axis: "z" };
}

export function defaultTubeParams(universeSize: Vec3): TubeParams {
  const s = defaultTargetSize(universeSize);
  return { outerRadius: s / 2, innerRadius: s / 3, height: s, axis: "z" };
}

export function defaultWedgeParams(universeSize: Vec3): WedgeParams {
  const s = defaultTargetSize(universeSize);
  return { size: [s, s, s], slope: 0.5 };
}

export function defaultPolygonPrismParams(universeSize: Vec3): PolygonPrismParams {
  const s = defaultTargetSize(universeSize);
  return { radius: s / 2, sides: 6, depth: s, axis: "z" };
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
    case "ellipsoid":
      return { kind: "ellipsoid", data: defaultEllipsoidParams(universeSize) };
    case "disk":
      return { kind: "disk", data: defaultDiskParams(universeSize) };
    case "thin_film": {
      const s = defaultTargetSize(universeSize);
      return { kind: "thin_film", data: { size: [s, s, Math.max(s * 0.08, 1e-9)] } };
    }
    case "pillar":
      return { kind: "pillar", data: defaultCylinderParams(universeSize) };
    case "nanowire": {
      const s = defaultTargetSize(universeSize);
      return { kind: "nanowire", data: { size: [Math.min(s * 3, universeSize[0] * 0.8), s * 0.35, s * 0.35] } };
    }
    case "ring":
      return { kind: "ring", data: defaultTubeParams(universeSize) };
    case "triangular_prism":
      return { kind: "triangular_prism", data: defaultTriangularPrismParams(universeSize) };
    case "cone":
      return { kind: "cone", data: defaultConeParams(universeSize) };
    case "capsule":
      return { kind: "capsule", data: defaultCapsuleParams(universeSize) };
    case "tube":
      return { kind: "tube", data: defaultTubeParams(universeSize) };
    case "wedge":
      return { kind: "wedge", data: defaultWedgeParams(universeSize) };
    case "polygon_prism":
      return { kind: "polygon_prism", data: defaultPolygonPrismParams(universeSize) };
  }
}

// ── Default primitive placement ───────────────────────────────

export interface DefaultPrimitiveContext {
  universe: UniverseNode;
  existingPrimitives: PrimitiveNode[];
  preferredSizeMeters?: number;
}

/**
 * Computes the AABB half-extent for a primitive (ignores rotation, conservative).
 */
export function halfExtentOfPrimitive(
  p: Pick<PrimitiveNode, "params" | "transform">,
): Vec3 {
  const [sx, sy, sz] = p.transform.scale;
  switch (p.params.kind) {
    case "box":
    case "thin_film":
    case "nanowire":
    case "wedge":
      return [
        (p.params.data.size[0] / 2) * sx,
        (p.params.data.size[1] / 2) * sy,
        (p.params.data.size[2] / 2) * sz,
      ];
    case "cylinder": {
      const { radius, height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (height / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (height / 2) * sz];
    }
    case "pillar": {
      const { radius, height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (height / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (height / 2) * sz];
    }
    case "sphere":
      return [p.params.data.radius * sx, p.params.data.radius * sy, p.params.data.radius * sz];
    case "ellipsoid":
      return [
        p.params.data.radii[0] * sx,
        p.params.data.radii[1] * sy,
        p.params.data.radii[2] * sz,
      ];
    case "disk": {
      const { radius, thickness, axis } = p.params.data;
      if (axis === "x") return [(thickness / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (thickness / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (thickness / 2) * sz];
    }
    case "ring":
    case "tube": {
      const { outerRadius, height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, outerRadius * sy, outerRadius * sz];
      if (axis === "y") return [outerRadius * sx, (height / 2) * sy, outerRadius * sz];
      return [outerRadius * sx, outerRadius * sy, (height / 2) * sz];
    }
    case "triangular_prism": {
      const { base, triangleHeight, depth, axis } = p.params.data;
      if (axis === "x") return [(depth / 2) * sx, (base / 2) * sy, (triangleHeight / 2) * sz];
      if (axis === "y") return [(base / 2) * sx, (depth / 2) * sy, (triangleHeight / 2) * sz];
      return [(base / 2) * sx, (triangleHeight / 2) * sy, (depth / 2) * sz];
    }
    case "cone":
    case "capsule": {
      const radius = p.params.kind === "cone"
        ? Math.max(p.params.data.radiusTop, p.params.data.radiusBottom)
        : p.params.data.radius;
      const { height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (height / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (height / 2) * sz];
    }
    case "polygon_prism": {
      const { radius, depth, axis } = p.params.data;
      if (axis === "x") return [(depth / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (depth / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (depth / 2) * sz];
    }
  }
}

/**
 * Creates a new PrimitiveNode with sensible defaults and smart placement:
 *
 * 1. If no existing primitives → place at Universe centre.
 * 2. If existing primitives exist → place to the +X side of the combined bounding box
 *    with a small gap, if it fits within Universe.
 * 3. If it doesn't fit → fall back to Universe centre and add a warning tag.
 */
export function createDefaultPrimitive(
  kind: PrimitiveKind,
  ctx: DefaultPrimitiveContext,
  nameCounters: Record<PrimitiveKind, number>,
): PrimitiveNode {
  const { universe, existingPrimitives, preferredSizeMeters } = ctx;
  const universeSize = universe.size;
  const params = defaultPrimitiveParams(kind, universeSize);

  // Determine the half-size of this new primitive for placement purposes.
  const targetSize =
    preferredSizeMeters ?? defaultTargetSize(universeSize);
  const halfSize = targetSize / 2;

  // Universe AABB
  const uMinX = universe.origin[0] - universeSize[0] / 2;
  const uMaxX = universe.origin[0] + universeSize[0] / 2;

  nameCounters[kind] += 1;
  const name = `${PRIMITIVE_DISPLAY_NAMES[kind]} ${String(nameCounters[kind]).padStart(3, "0")}`;

  let translation: Vec3 = [
    universe.origin[0],
    universe.origin[1],
    universe.origin[2],
  ];
  const tags: string[] = [];

  const enabledPrimitives = existingPrimitives.filter((p) => p.enabled);

  if (enabledPrimitives.length > 0) {
    // Find the maximum +X bound of existing objects.
    let maxXBound = -Infinity;
    for (const p of enabledPrimitives) {
      const he = halfExtentOfPrimitive(p);
      maxXBound = Math.max(maxXBound, p.transform.translation[0] + he[0]);
    }

    const gap = halfSize * 0.5;
    const candidateX = maxXBound + gap + halfSize;

    if (candidateX + halfSize <= uMaxX) {
      translation = [candidateX, universe.origin[1], universe.origin[2]];
    } else {
      // Doesn't fit beside existing objects; place at centre with warning.
      translation = [universe.origin[0], universe.origin[1], universe.origin[2]];
      tags.push("placement_warning:no_space_beside");
    }
  }

  // Ensure translation stays within Universe AABB on X
  if (translation[0] - halfSize < uMinX) {
    translation = [uMinX + halfSize, translation[1], translation[2]];
    tags.push("placement_warning:clamped_to_universe");
  }

  const transform: Transform3D = {
    ...IDENTITY_TRANSFORM,
    translation,
  };

  return {
    id: `prim-${nanoid(8)}`,
    kind: "primitive",
    primitiveKind: kind,
    name,
    enabled: true,
    visible: true,
    locked: false,
    transform,
    params,
    materialBindingId: null,
    tags,
  };
}
