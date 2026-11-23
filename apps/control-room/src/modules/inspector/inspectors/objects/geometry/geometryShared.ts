import type { JsonObject } from "@/kernel/api/apiTypes";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import { parseDraftQuantityField } from "@/kernel/authoring/object-edit/quantityDraftFields";
import { primitiveDraftBaseName } from "@/kernel/authoring/uniqueObjectName";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { formatLengthAuto } from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorTone } from "../../../template";

/* ── Canonical 10 Primitive Kinds & Polygon Vertex Row ── */

export type CanonicalPrimitiveKind =
  | "Box"
  | "Cylinder"
  | "Ellipsoid"
  | "Sphere"
  | "Tube"
  | "Cone"
  | "Torus"
  | "ArchWaveguide"
  | "PolygonExtrusion"
  | "ImportedMesh";

export type ArchProfileMode = "parabolic_arch" | "circular_arc";
export type CsgOperationMode = "none" | "union" | "difference" | "intersection";
export type RevisionConflictPhase =
  | "conflict"
  | "refreshing"
  | "refetched"
  | "rebased"
  | "refresh-error";

export interface PolygonVertexRow {
  readonly _rowId: string;
  readonly x_m: number;
  readonly y_m: number;
}

export interface ObjectGeometrySpecDraft {
  mode: "committed" | "draft-new" | "missing";
  objectId: string;
  draftName: string;
  materialRef: string | null;
  regionName: string;
  primitiveKind: CanonicalPrimitiveKind;
  symmetryAxis: "x" | "y" | "z";
  // Box / Ellipsoid
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  // Cylinder / Sphere
  radius: number;
  height: number;
  // Tube
  innerRadius: number;
  outerRadius: number;
  // Cone
  bottomRadius: number;
  topRadius: number;
  // Torus
  majorRadius: number;
  minorRadius: number;
  // ArchWaveguide
  archProfile: ArchProfileMode;
  length: number;
  width: number;
  archHeight: number;
  z0: number;
  archRadius: number;
  archAngleRad: number;
  // PolygonExtrusion
  polygonVertices: readonly PolygonVertexRow[];
  // ImportedMesh
  meshAssetPath: string;
  meshUnitScale: number;
  // Transform
  translation: readonly [number, number, number];
  eulerDeg: readonly [number, number, number];
  pivotMode: "centroid" | "origin" | "custom";
  pivotCustom: readonly [number, number, number];
  uniformScale: boolean;
  scale: readonly [number, number, number];
  // Boolean CSG
  csgOperation: CsgOperationMode;
  csgToolObjectId: string;
  csgKeepTool: boolean;
  preservedComplexCsg: JsonObject | null;
  preservedRawGeometry: JsonObject | null;
  hasRealizedOrDirtyMesh: boolean;
  meshStatusPill: { tone: InspectorTone; label: string };
}

let nextVertexSeq = 1;
export function createPolygonVertexRow(x_m: number, y_m: number, id?: string): PolygonVertexRow {
  return {
    _rowId: id ?? `poly-vtx-${nextVertexSeq++}`,
    x_m,
    y_m,
  };
}

export function normalizeZero(value: number): number {
  return Object.is(value, -0) || value === 0 ? 0 : value;
}

export function axisVectorFromSymmetryAxis(axis: "x" | "y" | "z"): [number, number, number] {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

export function parseSymmetryAxis(raw: unknown): "x" | "y" | "z" {
  if (raw === "x" || raw === "y" || raw === "z") return raw;
  if (Array.isArray(raw) && raw.length >= 3) {
    const ax = Math.abs(Number(raw[0]) || 0);
    const ay = Math.abs(Number(raw[1]) || 0);
    const az = Math.abs(Number(raw[2]) || 0);
    if (ax > ay && ax > az) return "x";
    if (ay > ax && ay > az) return "y";
  }
  return "z";
}

export function vec3ApproxEqual(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  epsilon = 1e-15,
): boolean {
  return (
    Math.abs(a[0] - b[0]) <= epsilon &&
    Math.abs(a[1] - b[1]) <= epsilon &&
    Math.abs(a[2] - b[2]) <= epsilon
  );
}

export function parseImportedMeshUnitScale(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  switch (raw) {
    case "nm":
      return 1e-9;
    case "um":
      return 1e-6;
    case "mm":
      return 1e-3;
    case "m":
      return 1;
    default:
      return 1e-9;
  }
}

export function normalizePrimitiveKind(raw: string | null | undefined): CanonicalPrimitiveKind {
  const clean = (raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (clean) {
    case "cylinder":
    case "disk":
      return "Cylinder";
    case "ellipsoid":
      return "Ellipsoid";
    case "sphere":
      return "Sphere";
    case "tube":
    case "ring":
    case "hollowcylinder":
      return "Tube";
    case "cone":
    case "frustum":
      return "Cone";
    case "torus":
      return "Torus";
    case "archwaveguide":
      return "ArchWaveguide";
    case "polygonextrusion":
    case "polygonprism":
    case "extrudedpolygon":
    case "polygon":
      return "PolygonExtrusion";
    case "importedmesh":
    case "importedsolid":
    case "mesh":
      return "ImportedMesh";
    default:
      return "Box";
  }
}

export function resolveDefaultDraftBaseName(
  selection: InspectorPanelProps["selection"],
  primitiveKind: CanonicalPrimitiveKind,
): string {
  const slug = (selection.nodeId?.split(":").at(-1) ?? "").toLowerCase();
  if (
    slug === "box" ||
    slug === "cylinder" ||
    slug === "sphere" ||
    slug === "thin-film" ||
    slug === "ellipsoid" ||
    slug === "cone" ||
    slug === "torus" ||
    slug === "polygon-prism" ||
    slug === "polygon_prism"
  ) {
    return primitiveDraftBaseName(selection.nodeId);
  }
  const trimmedLabel = selection.label?.trim();
  if (trimmedLabel) return trimmedLabel;
  return `New ${primitiveKind}`;
}

export function extractTranslationSIFromSessionDraft(
  draft: GeometryObjectDraft,
): readonly [number, number, number] | null {
  const axes = ["translation.0", "translation.1", "translation.2"] as const;
  const parsed = axes.map((field) => parseDraftQuantityField(draft, field));
  const values = parsed.map((entry) =>
    entry?.parseStatus === "valid" ? entry.parsedSI : entry?.lastValidSI ?? null,
  );
  if (values[0] === null || values[1] === null || values[2] === null) {
    return null;
  }
  return [values[0], values[1], values[2]];
}

/* ── Pure Validators & Coupled Helpers (Exported for Direct Unit Testing) ── */

export interface ArchWaveguideValidationInput {
  archProfile: ArchProfileMode;
  length: number;
  width: number;
  height: number;
  archHeight: number;
  archRadius: number;
  archAngleRad: number;
}

export function validateArchWaveguide(input: ArchWaveguideValidationInput): {
  valid: boolean;
  errors: Partial<
    Record<"length" | "width" | "height" | "archHeight" | "archRadius" | "archAngleRad", string>
  >;
} {
  const errors: Partial<
    Record<"length" | "width" | "height" | "archHeight" | "archRadius" | "archAngleRad", string>
  > = {};

  if (!Number.isFinite(input.length) || input.length <= 0) {
    errors.length = "Waveguide length L must be strictly positive.";
  }
  if (!Number.isFinite(input.width) || input.width <= 0) {
    errors.width = "Strip width w must be strictly positive.";
  }
  if (!Number.isFinite(input.height) || input.height <= 0) {
    errors.height = "Thickness h must be strictly positive.";
  }

  if (input.archProfile === "parabolic_arch") {
    if (!Number.isFinite(input.archHeight) || input.archHeight < 0) {
      errors.archHeight = "Apex arch height must be non-negative.";
    }
  } else {
    const halfWidth = input.width > 0 ? input.width / 2 : 0;
    if (!Number.isFinite(input.archRadius) || input.archRadius <= 0) {
      errors.archRadius = "Centerline arc radius R_arc must be strictly positive.";
    } else if (input.archRadius <= halfWidth) {
      errors.archRadius = `Arc radius R_arc must exceed half-width w/2 (${formatLengthAuto(halfWidth) ?? `${halfWidth} m`}) to prevent inner-edge self-intersection.`;
    }
    const absAngle = Math.abs(input.archAngleRad);
    if (!Number.isFinite(absAngle) || absAngle <= 0) {
      errors.archAngleRad = "Opening angle Δθ must be strictly greater than 0°.";
    } else if (absAngle >= 2 * Math.PI - 1e-9) {
      errors.archAngleRad =
        "Opening angle |Δθ| must be strictly less than 360° to prevent self-overlap.";
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateTubeRadii(innerRadius: number, outerRadius: number): string | null {
  if (!Number.isFinite(innerRadius) || innerRadius <= 0) {
    return "Inner radius R_in must be strictly greater than 0.";
  }
  if (!Number.isFinite(outerRadius) || outerRadius <= 0) {
    return "Outer radius R_out must be strictly greater than 0.";
  }
  if (innerRadius >= outerRadius) {
    return "Inner radius R_in must be strictly smaller than outer radius R_out.";
  }
  return null;
}

export function validateTorusRadii(majorRadius: number, minorRadius: number): string | null {
  if (!Number.isFinite(majorRadius) || majorRadius <= 0) {
    return "Major radius R_maj must be strictly greater than 0.";
  }
  if (!Number.isFinite(minorRadius) || minorRadius <= 0) {
    return "Minor tube radius r_min must be strictly greater than 0.";
  }
  if (minorRadius >= majorRadius) {
    return "Minor tube radius r_min must be strictly smaller than major radius R_maj to avoid spindle self-intersection.";
  }
  return null;
}

function segmentsIntersectProperly(
  a1: PolygonVertexRow,
  a2: PolygonVertexRow,
  b1: PolygonVertexRow,
  b2: PolygonVertexRow,
): boolean {
  const ccw = (p1: PolygonVertexRow, p2: PolygonVertexRow, p3: PolygonVertexRow) =>
    (p3.y_m - p1.y_m) * (p2.x_m - p1.x_m) - (p2.y_m - p1.y_m) * (p3.x_m - p1.x_m);
  const d1 = ccw(b1, b2, a1);
  const d2 = ccw(b1, b2, a2);
  const d3 = ccw(a1, a2, b1);
  const d4 = ccw(a1, a2, b2);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

export function validateSimplePolygon(vertices: readonly PolygonVertexRow[]): string | null {
  if (vertices.length < 3) {
    return "Polygon extrusion requires at least 3 vertices.";
  }
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a1 = vertices[i]!;
    const a2 = vertices[(i + 1) % n]!;
    if (Math.hypot(a2.x_m - a1.x_m, a2.y_m - a1.y_m) < 1e-15) {
      return "Adjacent polygon vertices must not coincide.";
    }
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = vertices[j]!;
      const b2 = vertices[(j + 1) % n]!;
      if (segmentsIntersectProperly(a1, a2, b1, b2)) {
        return "Polygon contour self-intersects; reorder vertices to form a simple closed polygon.";
      }
    }
  }
  return null;
}

export function applyUniformScaleChange(
  prevScale: readonly [number, number, number],
  nextScale: readonly [number, number, number],
  uniformScale: boolean,
): readonly [number, number, number] {
  if (!uniformScale) return nextScale;
  const changedIndices: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (!Object.is(prevScale[i], nextScale[i])) {
      changedIndices.push(i);
    }
  }
  if (changedIndices.length !== 1) {
    return nextScale;
  }
  const idx = changedIndices[0]!;
  const newVal = nextScale[idx]!;
  if (!Number.isFinite(newVal) || newVal <= 0) {
    return nextScale;
  }
  const prevVal = prevScale[idx]!;
  if (!Number.isFinite(prevVal) || prevVal <= 0) {
    return [newVal, newVal, newVal];
  }
  const ratio = newVal / prevVal;
  return ([0, 1, 2] as const).map((axis) => {
    if (axis === idx) return newVal;
    const base = prevScale[axis]!;
    if (!Number.isFinite(base) || base <= 0) return newVal;
    return Number((base * ratio).toPrecision(12));
  }) as unknown as readonly [number, number, number];
}

export function normalizeScaleForUniformLock(
  scale: readonly [number, number, number],
): readonly [number, number, number] {
  const firstValid = scale.find((v) => Number.isFinite(v) && v > 0) ?? 1;
  return [
    Number.isFinite(scale[0]) && scale[0] > 0 ? scale[0] : firstValid,
    Number.isFinite(scale[1]) && scale[1] > 0 ? scale[1] : firstValid,
    Number.isFinite(scale[2]) && scale[2] > 0 ? scale[2] : firstValid,
  ];
}

export function isUniformPositiveScale(
  scale: readonly [number, number, number],
): boolean {
  const [sx, sy, sz] = scale;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) {
    return false;
  }
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    return false;
  }
  const tol = 1e-9 * Math.max(1, Math.abs(sx));
  return Math.abs(sx - sy) <= tol && Math.abs(sx - sz) <= tol;
}

export function canBakeScaleIntoDraft(
  draft: Pick<ObjectGeometrySpecDraft, "primitiveKind" | "scale">,
): { ok: true } | { ok: false; reason: string } {
  if (draft.scale.some((c) => !Number.isFinite(c) || c <= 0)) {
    return {
      ok: false,
      reason: "All scale factors must be strictly positive before baking.",
    };
  }
  if (draft.primitiveKind === "ImportedMesh" && !isUniformPositiveScale(draft.scale)) {
    return {
      ok: false,
      reason: "ImportedMesh only supports uniform unit_scale baking (sx = sy = sz).",
    };
  }
  return { ok: true };
}

export function bakeScaleIntoDraft(
  draft: ObjectGeometrySpecDraft,
): Partial<ObjectGeometrySpecDraft> {
  const [sx, sy, sz] = draft.scale;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) {
    return {};
  }
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    return {};
  }
  const uni = Math.cbrt(Math.abs(sx * sy * sz)) || 1;
  const resetScale: readonly [number, number, number] = [1, 1, 1];
  switch (draft.primitiveKind) {
    case "Box":
    case "Ellipsoid":
      return {
        sizeX: draft.sizeX * Math.abs(sx),
        sizeY: draft.sizeY * Math.abs(sy),
        sizeZ: draft.sizeZ * Math.abs(sz),
        scale: resetScale,
      };
    case "Cylinder":
      return {
        radius: draft.radius * Math.sqrt(Math.abs(sx * sy)),
        height: draft.height * Math.abs(sz),
        scale: resetScale,
      };
    case "Sphere":
      return {
        radius: draft.radius * uni,
        scale: resetScale,
      };
    case "Tube":
      return {
        innerRadius: draft.innerRadius * Math.sqrt(Math.abs(sx * sy)),
        outerRadius: draft.outerRadius * Math.sqrt(Math.abs(sx * sy)),
        height: draft.height * Math.abs(sz),
        scale: resetScale,
      };
    case "Cone":
      return {
        bottomRadius: draft.bottomRadius * Math.sqrt(Math.abs(sx * sy)),
        topRadius: draft.topRadius * Math.sqrt(Math.abs(sx * sy)),
        height: draft.height * Math.abs(sz),
        scale: resetScale,
      };
    case "Torus":
      return {
        majorRadius: draft.majorRadius * Math.sqrt(Math.abs(sx * sy)),
        minorRadius: draft.minorRadius * Math.abs(sz),
        scale: resetScale,
      };
    case "ArchWaveguide":
      return {
        length: draft.length * Math.abs(sx),
        width: draft.width * Math.abs(sy),
        height: draft.height * Math.abs(sz),
        archHeight: draft.archHeight * Math.abs(sz),
        archRadius: draft.archRadius * Math.abs(sy),
        scale: resetScale,
      };
    case "PolygonExtrusion":
      return {
        height: draft.height * Math.abs(sz),
        polygonVertices: draft.polygonVertices.map((v) => ({
          ...v,
          x_m: v.x_m * sx,
          y_m: v.y_m * sy,
        })),
        scale: resetScale,
      };
    case "ImportedMesh":
      if (!isUniformPositiveScale(draft.scale)) {
        return {};
      }
      return {
        meshUnitScale: Number((draft.meshUnitScale * Math.abs(sx)).toPrecision(12)),
        scale: resetScale,
      };
  }
}
