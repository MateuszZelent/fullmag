/**
 * P1 — Placement Validation Engine
 *
 * Validates primitive placement against Universe bounds.
 * Conservative world-space AABB check (ignores rotation).
 *
 * P1 additions:
 *  - NaN/Inf guard on transform translation and scale.
 *  - Preview-only warning for sphere, disk, triangular_prism.
 *  - Distinguishes "partially crosses boundary" (warning) from
 *    "center or all volume outside Universe" (error).
 *  - Computes suggested corrective actions: expand_universe / move_inside.
 */

import type {
  PrimitiveNode,
  UniverseNode,
  PlacementValidation,
  GeometryDiagnostic,
  GeometrySuggestedAction,
  Vec3,
} from "../model/types";
import { PRIMITIVE_CAPABILITIES } from "../model/types";

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
    case "thin_film":
    case "nanowire":
    case "wedge":
      halfExtent = [
        (p.params.data.size[0] / 2) * sx,
        (p.params.data.size[1] / 2) * sy,
        (p.params.data.size[2] / 2) * sz,
      ];
      break;
    case "cylinder":
    case "pillar": {
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
    case "ellipsoid":
      halfExtent = [
        p.params.data.radii[0] * sx,
        p.params.data.radii[1] * sy,
        p.params.data.radii[2] * sz,
      ];
      break;
    case "disk": {
      const { radius, thickness, axis } = p.params.data;
      if (axis === "x") halfExtent = [(thickness / 2) * sx, radius * sy, radius * sz];
      else if (axis === "y") halfExtent = [radius * sx, (thickness / 2) * sy, radius * sz];
      else halfExtent = [radius * sx, radius * sy, (thickness / 2) * sz];
      break;
    }
    case "ring":
    case "tube": {
      const { outerRadius, height, axis } = p.params.data;
      if (axis === "x") halfExtent = [(height / 2) * sx, outerRadius * sy, outerRadius * sz];
      else if (axis === "y") halfExtent = [outerRadius * sx, (height / 2) * sy, outerRadius * sz];
      else halfExtent = [outerRadius * sx, outerRadius * sy, (height / 2) * sz];
      break;
    }
    case "triangular_prism": {
      const { base, triangleHeight, depth, axis } = p.params.data;
      if (axis === "x") halfExtent = [(depth / 2) * sx, (base / 2) * sy, (triangleHeight / 2) * sz];
      else if (axis === "y") halfExtent = [(base / 2) * sx, (depth / 2) * sy, (triangleHeight / 2) * sz];
      else halfExtent = [(base / 2) * sx, (triangleHeight / 2) * sy, (depth / 2) * sz];
      break;
    }
    case "cone":
    case "capsule": {
      const radius = p.params.kind === "cone"
        ? Math.max(p.params.data.radiusTop, p.params.data.radiusBottom)
        : p.params.data.radius;
      const { height, axis } = p.params.data;
      if (axis === "x") halfExtent = [(height / 2) * sx, radius * sy, radius * sz];
      else if (axis === "y") halfExtent = [radius * sx, (height / 2) * sy, radius * sz];
      else halfExtent = [radius * sx, radius * sy, (height / 2) * sz];
      break;
    }
    case "polygon_prism": {
      const { radius, depth, axis } = p.params.data;
      if (axis === "x") halfExtent = [(depth / 2) * sx, radius * sy, radius * sz];
      else if (axis === "y") halfExtent = [radius * sx, (depth / 2) * sy, radius * sz];
      else halfExtent = [radius * sx, radius * sy, (depth / 2) * sz];
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
  const suggestedActions: GeometrySuggestedAction[] = [];
  let selfInvalid = false;

  // ── 1. NaN / Inf guard ─────────────────────────────────────
  const { translation, scale } = primitive.transform;
  const transformValues = [...translation, ...scale];
  if (transformValues.some((v) => !isFinite(v))) {
    selfInvalid = true;
    diagnostics.push({
      nodeId: primitive.id,
      severity: "error",
      code: "invalid_transform",
      message: "Transform contains NaN or Infinity values",
    });
    // Cannot compute meaningful AABB — return early.
    return {
      withinUniverse: false,
      intersectsUniverseBoundary: false,
      exceedsUniverse: true,
      selfInvalid: true,
      diagnostics,
      suggestedActions,
    };
  }

  // ── 2. Preview-only capability warning ────────────────────
  const capability = PRIMITIVE_CAPABILITIES[primitive.params.kind];
  if (capability.status === "preview") {
    diagnostics.push({
      nodeId: primitive.id,
      severity: "warning",
      code: "preview_only_unsupported",
      message: `${primitive.params.kind} is a preview primitive and is not yet supported in FDM or FEM solvers`,
    });
  }

  // ── 3. Scale sanity check ──────────────────────────────────
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

  // ── 4. Zero-size param check ───────────────────────────────
  switch (primitive.params.kind) {
    case "box":
    case "thin_film":
    case "nanowire":
    case "wedge":
      if (primitive.params.data.size.some((s) => s <= 0)) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Primitive has zero or negative dimension" });
      }
      break;
    case "cylinder":
    case "pillar":
      if (primitive.params.data.radius <= 0 || primitive.params.data.height <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Cylinder-like primitive has zero or negative radius/height" });
      }
      break;
    case "sphere":
      if (primitive.params.data.radius <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Sphere has zero or negative radius" });
      }
      break;
    case "ellipsoid":
      if (primitive.params.data.radii.some((r) => r <= 0)) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Ellipsoid has zero or negative radius" });
      }
      break;
    case "disk":
      if (primitive.params.data.radius <= 0 || primitive.params.data.thickness <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Disk has zero or negative radius/thickness" });
      }
      break;
    case "ring":
    case "tube":
      if (
        primitive.params.data.outerRadius <= 0 ||
        primitive.params.data.innerRadius <= 0 ||
        primitive.params.data.innerRadius >= primitive.params.data.outerRadius ||
        primitive.params.data.height <= 0
      ) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Tube has invalid inner/outer radius or height" });
      }
      break;
    case "triangular_prism":
      if (
        primitive.params.data.base <= 0 ||
        primitive.params.data.triangleHeight <= 0 ||
        primitive.params.data.depth <= 0
      ) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Triangular prism has zero or negative dimensions" });
      }
      break;
    case "cone":
      if (primitive.params.data.radiusTop < 0 || primitive.params.data.radiusBottom <= 0 || primitive.params.data.height <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Cone has invalid radii or height" });
      }
      break;
    case "capsule":
      if (primitive.params.data.radius <= 0 || primitive.params.data.height <= 0) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Capsule has zero or negative radius/height" });
      }
      break;
    case "polygon_prism":
      if (primitive.params.data.radius <= 0 || primitive.params.data.depth <= 0 || primitive.params.data.sides < 3) {
        selfInvalid = true;
        diagnostics.push({ nodeId: primitive.id, severity: "error", code: "zero_size", message: "Polygon prism has invalid radius, depth, or side count" });
      }
      break;
  }

  // ── 5. Universe bounds check ───────────────────────────────
  const pAABB = computeWorldAABB(primitive);
  const uAABB = universeAABB(universe);

  // Center of primitive AABB
  const primCenterX = (pAABB.min[0] + pAABB.max[0]) / 2;
  const primCenterY = (pAABB.min[1] + pAABB.max[1]) / 2;
  const primCenterZ = (pAABB.min[2] + pAABB.max[2]) / 2;
  const primCenter: Vec3 = [primCenterX, primCenterY, primCenterZ];

  let exceedsUniverse = false;
  let intersectsUniverseBoundary = false;

  for (let i = 0; i < 3; i++) {
    const below = pAABB.min[i] < uAABB.min[i];
    const above = pAABB.max[i] > uAABB.max[i];

    if (below || above) {
      intersectsUniverseBoundary = true;

      // Determine if the primitive center is also outside → error; otherwise → warning
      const centerOutside =
        primCenter[i] < uAABB.min[i] || primCenter[i] > uAABB.max[i];

      if (centerOutside) {
        exceedsUniverse = true;
        diagnostics.push({
          nodeId: primitive.id,
          severity: "error",
          code: "out_of_bounds",
          message: `Object center is outside Universe on ${AXES[i]} axis`,
        });
      } else {
        diagnostics.push({
          nodeId: primitive.id,
          severity: "warning",
          code: "crosses_boundary",
          message: `Object crosses Universe boundary on ${AXES[i]} axis`,
        });
      }
    }
  }

  // ── 6. Suggested actions ───────────────────────────────────
  if (intersectsUniverseBoundary) {
    // expand_universe: compute a universe that tightly contains the primitive (with 10% padding)
    const PADDING = 0.1;
    const requiredSize: Vec3 = [
      (pAABB.max[0] - pAABB.min[0]) * (1 + PADDING),
      (pAABB.max[1] - pAABB.min[1]) * (1 + PADDING),
      (pAABB.max[2] - pAABB.min[2]) * (1 + PADDING),
    ];
    // Merge required with current universe extents so existing primitives still fit
    const mergedMin: Vec3 = [
      Math.min(uAABB.min[0], pAABB.min[0]),
      Math.min(uAABB.min[1], pAABB.min[1]),
      Math.min(uAABB.min[2], pAABB.min[2]),
    ];
    const mergedMax: Vec3 = [
      Math.max(uAABB.max[0], pAABB.max[0]),
      Math.max(uAABB.max[1], pAABB.max[1]),
      Math.max(uAABB.max[2], pAABB.max[2]),
    ];
    const expandedSize: Vec3 = [
      (mergedMax[0] - mergedMin[0]) * (1 + PADDING),
      (mergedMax[1] - mergedMin[1]) * (1 + PADDING),
      (mergedMax[2] - mergedMin[2]) * (1 + PADDING),
    ];
    const expandedOrigin: Vec3 = [
      (mergedMin[0] + mergedMax[0]) / 2,
      (mergedMin[1] + mergedMax[1]) / 2,
      (mergedMin[2] + mergedMax[2]) / 2,
    ];
    suggestedActions.push({
      kind: "expand_universe",
      requiredSize: expandedSize,
      requiredOrigin: expandedOrigin,
    });

    // move_inside: compute clamped translation
    const clampedTranslation = clampToUniverse(primitive, universe);
    const [tx, ty, tz] = primitive.transform.translation;
    if (
      Math.abs(clampedTranslation[0] - tx) > 0 ||
      Math.abs(clampedTranslation[1] - ty) > 0 ||
      Math.abs(clampedTranslation[2] - tz) > 0
    ) {
      suggestedActions.push({
        kind: "move_inside",
        suggestedTranslation: clampedTranslation,
      });
    }

    suggestedActions.push({
      kind: "clip_with_ack",
    });
  }

  const withinUniverse = !exceedsUniverse && !intersectsUniverseBoundary;

  return {
    withinUniverse,
    intersectsUniverseBoundary,
    exceedsUniverse,
    selfInvalid,
    diagnostics,
    suggestedActions,
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
