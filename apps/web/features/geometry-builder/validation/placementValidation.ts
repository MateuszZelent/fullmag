/**
 * P5 — Placement Validation Engine
 *
 * Validates primitive placement against Universe bounds.
 * Uses conservative world AABB check for MVP.
 */

import type {
  PrimitiveNode,
  UniverseNode,
  PlacementValidation,
  GeometryDiagnostic,
  Vec3,
} from "../model/types";

/**
 * Compute the world-space AABB of a primitive.
 * Conservative: ignores rotation, uses scale × param extents + translation.
 */
function computeWorldAABB(p: PrimitiveNode): { min: Vec3; max: Vec3 } {
  const [tx, ty, tz] = p.transform.translation;
  const [sx, sy, sz] = p.transform.scale;
  let halfExtent: Vec3;

  switch (p.params.kind) {
    case "box":
      halfExtent = [
        (p.params.data.size[0] / 2) * sx,
        (p.params.data.size[1] / 2) * sy,
        (p.params.data.size[2] / 2) * sz,
      ];
      break;
    case "cylinder": {
      const { radius, height, axis } = p.params.data;
      if (axis === "x") halfExtent = [(height / 2) * sx, radius * sy, radius * sz];
      else if (axis === "y") halfExtent = [radius * sx, (height / 2) * sy, radius * sz];
      else halfExtent = [radius * sx, radius * sy, (height / 2) * sz];
      break;
    }
    case "sphere": {
      const r = p.params.data.radius;
      halfExtent = [r * sx, r * sy, r * sz];
      break;
    }
    case "disk": {
      const { radius, thickness, axis } = p.params.data;
      if (axis === "x") halfExtent = [(thickness / 2) * sx, radius * sy, radius * sz];
      else if (axis === "y") halfExtent = [radius * sx, (thickness / 2) * sy, radius * sz];
      else halfExtent = [radius * sx, radius * sy, (thickness / 2) * sz];
      break;
    }
    case "triangular_prism": {
      const { base, triangleHeight, depth, axis } = p.params.data;
      if (axis === "x") halfExtent = [(depth / 2) * sx, (base / 2) * sy, (triangleHeight / 2) * sz];
      else if (axis === "y") halfExtent = [(base / 2) * sx, (depth / 2) * sy, (triangleHeight / 2) * sz];
      else halfExtent = [(base / 2) * sx, (triangleHeight / 2) * sy, (depth / 2) * sz];
      break;
    }
  }

  return {
    min: [tx - halfExtent[0], ty - halfExtent[1], tz - halfExtent[2]],
    max: [tx + halfExtent[0], ty + halfExtent[1], tz + halfExtent[2]],
  };
}

function universeAABB(u: UniverseNode): { min: Vec3; max: Vec3 } {
  const [ox, oy, oz] = u.origin;
  const [sx, sy, sz] = u.size;
  return {
    min: [ox - sx / 2, oy - sy / 2, oz - sz / 2],
    max: [ox + sx / 2, oy + sy / 2, oz + sz / 2],
  };
}

const AXES = ["X", "Y", "Z"] as const;

export function validatePlacement(
  primitive: PrimitiveNode,
  universe: UniverseNode,
): PlacementValidation {
  const diagnostics: GeometryDiagnostic[] = [];
  const pAABB = computeWorldAABB(primitive);
  const uAABB = universeAABB(universe);

  let exceedsUniverse = false;
  let intersectsUniverseBoundary = false;

  // Check each axis
  for (let i = 0; i < 3; i++) {
    if (pAABB.min[i] < uAABB.min[i]) {
      exceedsUniverse = true;
      intersectsUniverseBoundary = true;
      diagnostics.push({
        nodeId: primitive.id,
        severity: "error",
        code: "out_of_bounds",
        message: `Object exceeds Universe bounds on -${AXES[i]}`,
      });
    }
    if (pAABB.max[i] > uAABB.max[i]) {
      exceedsUniverse = true;
      intersectsUniverseBoundary = true;
      diagnostics.push({
        nodeId: primitive.id,
        severity: "error",
        code: "out_of_bounds",
        message: `Object exceeds Universe bounds on +${AXES[i]}`,
      });
    }
  }

  // Check degenerate dimensions
  let selfInvalid = false;
  for (let i = 0; i < 3; i++) {
    if (primitive.transform.scale[i] <= 0) {
      selfInvalid = true;
      diagnostics.push({
        nodeId: primitive.id,
        severity: "error",
        code: "degenerate_scale",
        message: `Non-positive scale on ${AXES[i]} axis`,
      });
    }
  }

  // Check zero-size params
  switch (primitive.params.kind) {
    case "box":
      if (primitive.params.data.size.some((s) => s <= 0)) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Box has zero or negative dimension" });
      }
      break;
    case "cylinder":
      if (primitive.params.data.radius <= 0 || primitive.params.data.height <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Cylinder has zero or negative radius/height" });
      }
      break;
    case "sphere":
      if (primitive.params.data.radius <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Sphere has zero or negative radius" });
      }
      break;
    case "disk":
      if (primitive.params.data.radius <= 0 || primitive.params.data.thickness <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Disk has zero or negative radius/thickness" });
      }
      break;
    case "triangular_prism":
      if (primitive.params.data.base <= 0 || primitive.params.data.triangleHeight <= 0 || primitive.params.data.depth <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Triangular prism has zero or negative dimensions" });
      }
      break;
  }

  const withinUniverse = !exceedsUniverse;

  return {
    withinUniverse,
    intersectsUniverseBoundary,
    exceedsUniverse,
    selfInvalid,
    diagnostics,
  };
}

/**
 * Clamp a primitive's translation so that its AABB stays within universe bounds.
 * Returns the clamped translation vector.
 */
export function clampToUniverse(
  primitive: PrimitiveNode,
  universe: UniverseNode,
): Vec3 {
  const pAABB = computeWorldAABB(primitive);
  const uAABB = universeAABB(universe);
  const [tx, ty, tz] = primitive.transform.translation;

  const halfW: Vec3 = [
    (pAABB.max[0] - pAABB.min[0]) / 2,
    (pAABB.max[1] - pAABB.min[1]) / 2,
    (pAABB.max[2] - pAABB.min[2]) / 2,
  ];

  return [
    Math.max(uAABB.min[0] + halfW[0], Math.min(uAABB.max[0] - halfW[0], tx)),
    Math.max(uAABB.min[1] + halfW[1], Math.min(uAABB.max[1] - halfW[1], ty)),
    Math.max(uAABB.min[2] + halfW[2], Math.min(uAABB.max[2] - halfW[2], tz)),
  ];
}
