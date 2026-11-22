"use client";

import {
  Box,
  Check,
  Combine,
  Compass,
  Copy,
  Move3d,
  Plus,
  Shapes,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  createObjectTransaction,
  patchObjectGeometryTransaction,
  primitiveDraftOverlayStore,
  type PrimitiveDraft,
} from "@/kernel/authoring/geometryLifecycleCommands";
import {
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  canonicalDraftInSelectedUnits,
  parseDraftQuantityField,
  updateQuantityFieldSI,
} from "@/kernel/authoring/object-edit/quantityDraftFields";
import { useObjectEditSelector } from "@/kernel/authoring/object-edit/useObjectEditSelector";
import {
  primitiveDraftBaseName,
  resolveDraftObjectName,
} from "@/kernel/authoring/uniqueObjectName";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { DisabledReason } from "@/shared/ui/DisabledReason";
import { Input } from "@/shared/ui/Input";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
  type InspectorTone,
} from "../../template";
import {
  isPrimitiveDraftRevisionConflict,
  rebaseGeometryObjectDraft,
  resolveGeometryObjectDraft,
  summarizeGeometryValidationMessages,
} from "../geometryObjectPanelModel";
import {
  ANGLE_UNITS,
  buildObjectSelection,
  buildRootSelection,
  eulerDegToQuat,
  formatLengthAuto,
  formatSpanAuto,
  formatVolumeAuto,
  LENGTH_UNITS,
  quatToEulerDeg,
  type SceneObjectItem as SceneObject,
} from "../model-roots/SpecInspectorHost";
import {
  rebaseDirtyDraftOntoUnchangedObject,
  reconcileObjectEditAck,
} from "../objectEditAckReconciliation";

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
type RevisionConflictPhase =
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

function normalizeZero(value: number): number {
  return Object.is(value, -0) || value === 0 ? 0 : value;
}

function axisVectorFromSymmetryAxis(axis: "x" | "y" | "z"): [number, number, number] {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function parseSymmetryAxis(raw: unknown): "x" | "y" | "z" {
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

function vec3ApproxEqual(
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
  errors: Partial<Record<"length" | "width" | "height" | "archHeight" | "archRadius" | "archAngleRad", string>>;
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
      errors.archAngleRad = "Opening angle |Δθ| must be strictly less than 360° to prevent self-overlap.";
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
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
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
  if (
    draft.primitiveKind === "ImportedMesh" &&
    !isUniformPositiveScale(draft.scale)
  ) {
    return {
      ok: false,
      reason:
        "ImportedMesh only supports uniform unit_scale baking (sx = sy = sz).",
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

/* ── Serialization & Parsing ── */

function parseImportedMeshUnitScale(raw: unknown): number {
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

function normalizePrimitiveKind(raw: string | null | undefined): CanonicalPrimitiveKind {
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

function resolveDefaultDraftBaseName(
  selection: InspectorPanelProps["selection"],
  primitiveKind: CanonicalPrimitiveKind,
): string {
  const slug = (selection.nodeId?.split(":").at(-1) ?? "").toLowerCase();
  if (slug === "box" || slug === "cylinder" || slug === "sphere" || slug === "thin-film") {
    return primitiveDraftBaseName(selection.nodeId);
  }
  const trimmedLabel = selection.label?.trim();
  if (trimmedLabel) return trimmedLabel;
  return `New ${primitiveKind}`;
}

export function serializeGeometryPayload(draft: ObjectGeometrySpecDraft): JsonObject {
  const rawGeomParams = draft.preservedRawGeometry?.geometry_params;
  const baseParams: Record<string, unknown> =
    rawGeomParams && typeof rawGeomParams === "object" && !Array.isArray(rawGeomParams)
      ? (rawGeomParams as Record<string, unknown>)
      : {};

  let primitiveDescriptor: JsonObject;
  switch (draft.primitiveKind) {
    case "Box":
      primitiveDescriptor = {
        geometry_kind: "Box",
        geometry_params: {
          ...baseParams,
          size: [draft.sizeX, draft.sizeY, draft.sizeZ],
        },
      };
      break;
    case "Cylinder":
      primitiveDescriptor = {
        geometry_kind: "Cylinder",
        geometry_params: {
          ...baseParams,
          radius: draft.radius,
          height: draft.height,
          axis: axisVectorFromSymmetryAxis(draft.symmetryAxis),
        },
      };
      break;
    case "Ellipsoid":
      primitiveDescriptor = {
        geometry_kind: "Ellipsoid",
        geometry_params: {
          ...baseParams,
          size: [draft.sizeX, draft.sizeY, draft.sizeZ],
          radii: [draft.sizeX / 2, draft.sizeY / 2, draft.sizeZ / 2],
        },
      };
      break;
    case "Sphere":
      primitiveDescriptor = {
        geometry_kind: "Sphere",
        geometry_params: {
          ...baseParams,
          radius: draft.radius,
        },
      };
      break;
    case "Tube":
      primitiveDescriptor = {
        geometry_kind: "Tube",
        geometry_params: {
          ...baseParams,
          inner_radius: draft.innerRadius,
          outer_radius: draft.outerRadius,
          height: draft.height,
          axis: draft.symmetryAxis,
        },
      };
      break;
    case "Cone":
      primitiveDescriptor = {
        geometry_kind: "Cone",
        geometry_params: {
          ...baseParams,
          bottom_radius: draft.bottomRadius,
          top_radius: draft.topRadius,
          height: draft.height,
          axis: draft.symmetryAxis,
        },
      };
      break;
    case "Torus":
      primitiveDescriptor = {
        geometry_kind: "Torus",
        geometry_params: {
          ...baseParams,
          major_radius: draft.majorRadius,
          minor_radius: draft.minorRadius,
          axis: draft.symmetryAxis,
        },
      };
      break;
    case "ArchWaveguide": {
      const effectiveArchHeight =
        draft.archProfile === "circular_arc"
          ? draft.archRadius * (1 - Math.cos(Math.abs(draft.archAngleRad) / 2))
          : draft.archHeight;
      primitiveDescriptor = {
        geometry_kind: "ArchWaveguide",
        geometry_params: {
          ...baseParams,
          profile_kind: draft.archProfile,
          length: draft.length,
          width: draft.width,
          height: draft.height,
          arch_height: effectiveArchHeight,
          z0: draft.z0,
          ...(draft.archProfile === "circular_arc"
            ? {
                arc_radius: draft.archRadius,
                arc_angle_rad: draft.archAngleRad,
              }
            : {}),
        },
      };
      break;
    }
    case "PolygonExtrusion":
      primitiveDescriptor = {
        geometry_kind: "PolygonExtrusion",
        geometry_params: {
          ...baseParams,
          height: draft.height,
          axis: draft.symmetryAxis,
          vertices: draft.polygonVertices.map((v) => [v.x_m, v.y_m]),
        },
      };
      break;
    case "ImportedMesh":
      primitiveDescriptor = {
        geometry_kind: "ImportedMesh",
        geometry_params: {
          ...baseParams,
          asset_path: draft.meshAssetPath.trim(),
          unit_scale: draft.meshUnitScale,
        },
      };
      break;
  }

  if (draft.csgOperation !== "none" && draft.csgToolObjectId.trim()) {
    return {
      ...primitiveDescriptor,
      csg_operation: {
        kind: draft.csgOperation,
        tool_object_id: draft.csgToolObjectId.trim(),
        keep_tool: draft.csgKeepTool,
      },
    };
  }
  if (draft.preservedComplexCsg && draft.csgOperation === "none") {
    return {
      ...draft.preservedRawGeometry,
      ...primitiveDescriptor,
      csg_tree: draft.preservedComplexCsg,
    };
  }
  return {
    ...(draft.preservedRawGeometry ?? {}),
    ...primitiveDescriptor,
  };
}

export function serializeTransformPayload(draft: ObjectGeometrySpecDraft): JsonObject {
  const quat = eulerDegToQuat(draft.eulerDeg);
  const [tx, ty, tz] = draft.translation;
  const pivot: [number, number, number] =
    draft.pivotMode === "custom"
      ? [
          normalizeZero(draft.pivotCustom[0]),
          normalizeZero(draft.pivotCustom[1]),
          normalizeZero(draft.pivotCustom[2]),
        ]
      : draft.pivotMode === "origin"
        ? [normalizeZero(-tx), normalizeZero(-ty), normalizeZero(-tz)]
        : [0, 0, 0];
  return {
    translation: [normalizeZero(tx), normalizeZero(ty), normalizeZero(tz)],
    rotation_quat: quat,
    scale: [draft.scale[0], draft.scale[1], draft.scale[2]],
    pivot,
    ...(draft.pivotMode !== "centroid" ? { pivot_mode: draft.pivotMode } : {}),
  };
}

export function resolvePreviewOverlayDraft(
  draft: ObjectGeometrySpecDraft,
  lastValid?: Partial<ObjectGeometrySpecDraft> | null,
  externalErrors?: ReadonlyMap<string, string>,
): PrimitiveDraft {
  const errors: Record<string, string> = {};
  if (externalErrors) {
    for (const [k, v] of externalErrors.entries()) {
      errors[k] = v;
    }
  }

  const positiveValue = (
    value: number,
    fallback: number | undefined,
    key: string,
    label: string,
  ): number | null => {
    if (Number.isFinite(value) && value > 0) return value;
    errors[key] ??= !Number.isFinite(value)
      ? `${label} must be a finite SI value.`
      : `${label} must be greater than 0.`;
    return typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0
      ? fallback
      : null;
  };

  const nonNegativeValue = (
    value: number,
    fallback: number | undefined,
    key: string,
    label: string,
  ): number | null => {
    if (Number.isFinite(value) && value >= 0) return value;
    errors[key] ??= !Number.isFinite(value)
      ? `${label} must be a finite SI value.`
      : `${label} must be non-negative.`;
    return typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0
      ? fallback
      : null;
  };

  const finiteValue = (
    value: number,
    fallback: number | undefined,
    key: string,
    label: string,
  ): number | null => {
    if (Number.isFinite(value)) return value;
    errors[key] ??= `${label} must be a finite SI value.`;
    return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : null;
  };

  const kind: PrimitiveDraft["kind"] =
    draft.primitiveKind === "Cylinder" ||
    draft.primitiveKind === "Tube" ||
    draft.primitiveKind === "Cone"
      ? "Cylinder"
      : draft.primitiveKind === "Sphere"
        ? "Sphere"
        : "Box";

  let dims: [number, number, number] | null = null;
  if (draft.primitiveKind === "Cylinder") {
    const r = positiveValue(draft.radius, lastValid?.radius, "radius", "Radius");
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    dims = r !== null && h !== null ? [2 * r, h, 2 * r] : null;
  } else if (draft.primitiveKind === "Sphere") {
    const r = positiveValue(draft.radius, lastValid?.radius, "radius", "Radius");
    dims = r !== null ? [2 * r, 2 * r, 2 * r] : null;
  } else if (draft.primitiveKind === "Tube") {
    const outR = positiveValue(
      draft.outerRadius,
      lastValid?.outerRadius,
      "outerRadius",
      "Outer radius",
    );
    const inR = positiveValue(
      draft.innerRadius,
      lastValid?.innerRadius,
      "innerRadius",
      "Inner radius",
    );
    if (inR !== null && outR !== null && inR >= outR && draft.innerRadius >= draft.outerRadius) {
      errors.innerRadius ??= "Inner radius R_in must be strictly smaller than outer radius R_out.";
    }
    const effOutR =
      draft.innerRadius >= draft.outerRadius &&
      typeof lastValid?.outerRadius === "number" &&
      lastValid.outerRadius > 0
        ? lastValid.outerRadius
        : outR;
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    dims = effOutR !== null && h !== null ? [2 * effOutR, h, 2 * effOutR] : null;
  } else if (draft.primitiveKind === "Cone") {
    const bR = nonNegativeValue(
      draft.bottomRadius,
      lastValid?.bottomRadius,
      "bottomRadius",
      "Bottom radius",
    );
    const tR = nonNegativeValue(
      draft.topRadius,
      lastValid?.topRadius,
      "topRadius",
      "Top radius",
    );
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    let maxR = bR !== null && tR !== null ? Math.max(bR, tR) : null;
    if (maxR !== null && maxR <= 0) {
      errors.bottomRadius ??= "At least one cone radius must be strictly positive.";
      const fallbackMax = Math.max(lastValid?.bottomRadius ?? 0, lastValid?.topRadius ?? 0);
      maxR = fallbackMax > 0 ? fallbackMax : null;
    }
    dims = maxR !== null && h !== null ? [2 * maxR, h, 2 * maxR] : null;
  } else if (draft.primitiveKind === "Torus") {
    const majR = positiveValue(
      draft.majorRadius,
      lastValid?.majorRadius,
      "majorRadius",
      "Major radius",
    );
    const minR = positiveValue(
      draft.minorRadius,
      lastValid?.minorRadius,
      "minorRadius",
      "Minor radius",
    );
    if (majR !== null && minR !== null) {
      const d = 2 * (majR + minR);
      dims = [d, d, 2 * minR];
    }
  } else if (draft.primitiveKind === "ArchWaveguide") {
    const len = positiveValue(draft.length, lastValid?.length, "length", "Span length");
    const wid = positiveValue(draft.width, lastValid?.width, "width", "Strip width");
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    const archH = nonNegativeValue(
      draft.archHeight,
      lastValid?.archHeight,
      "archHeight",
      "Apex arch height",
    );
    dims = len !== null && wid !== null && h !== null && archH !== null
      ? [len, wid, h + archH]
      : null;
  } else if (draft.primitiveKind === "PolygonExtrusion") {
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    const verts = draft.polygonVertices.length >= 3
      ? draft.polygonVertices
      : lastValid?.polygonVertices ?? [];
    if (h !== null && verts.length >= 3) {
      const xs = verts.map((v) => v.x_m);
      const ys = verts.map((v) => v.y_m);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      dims = [Math.max(spanX, 1e-9), Math.max(spanY, 1e-9), h];
    }
  } else {
    const sx = positiveValue(draft.sizeX, lastValid?.sizeX, "sizeX", "Extent X");
    const sy = positiveValue(draft.sizeY, lastValid?.sizeY, "sizeY", "Extent Y");
    const sz = positiveValue(draft.sizeZ, lastValid?.sizeZ, "sizeZ", "Thickness Z");
    dims = sx !== null && sy !== null && sz !== null ? [sx, sy, sz] : null;
  }

  const fbTrans = lastValid?.translation;
  const tx = finiteValue(draft.translation[0], fbTrans?.[0], "translation.0", "Position X");
  const ty = finiteValue(draft.translation[1], fbTrans?.[1], "translation.1", "Position Y");
  const tz = finiteValue(draft.translation[2], fbTrans?.[2], "translation.2", "Position Z");

  return {
    kind,
    dimensions: dims,
    translation: tx !== null && ty !== null && tz !== null ? [tx, ty, tz] : null,
    errors,
  };
}

function updateLastValidDraftSnapshot(
  prev: ObjectGeometrySpecDraft,
  current: ObjectGeometrySpecDraft,
): ObjectGeometrySpecDraft {
  const pos = (next: number, fb: number) => (Number.isFinite(next) && next > 0 ? next : fb);
  const nonNeg = (next: number, fb: number) => (Number.isFinite(next) && next >= 0 ? next : fb);
  const fin = (next: number, fb: number) => (Number.isFinite(next) ? next : fb);

  const coneRadiiValid =
    Number.isFinite(current.bottomRadius) &&
    current.bottomRadius >= 0 &&
    Number.isFinite(current.topRadius) &&
    current.topRadius >= 0 &&
    current.bottomRadius + current.topRadius > 0;

  return {
    ...current,
    sizeX: pos(current.sizeX, prev.sizeX),
    sizeY: pos(current.sizeY, prev.sizeY),
    sizeZ: pos(current.sizeZ, prev.sizeZ),
    radius: pos(current.radius, prev.radius),
    height: pos(current.height, prev.height),
    innerRadius:
      Number.isFinite(current.innerRadius) &&
      current.innerRadius > 0 &&
      current.innerRadius < pos(current.outerRadius, prev.outerRadius)
        ? current.innerRadius
        : prev.innerRadius,
    outerRadius:
      Number.isFinite(current.outerRadius) &&
      current.outerRadius > 0 &&
      current.outerRadius > pos(current.innerRadius, prev.innerRadius)
        ? current.outerRadius
        : prev.outerRadius,
    bottomRadius: coneRadiiValid ? current.bottomRadius : prev.bottomRadius,
    topRadius: coneRadiiValid ? current.topRadius : prev.topRadius,
    majorRadius: pos(current.majorRadius, prev.majorRadius),
    minorRadius: pos(current.minorRadius, prev.minorRadius),
    length: pos(current.length, prev.length),
    width: pos(current.width, prev.width),
    archHeight: nonNeg(current.archHeight, prev.archHeight),
    translation: [
      fin(current.translation[0], prev.translation[0]),
      fin(current.translation[1], prev.translation[1]),
      fin(current.translation[2], prev.translation[2]),
    ],
  };
}

export function buildBaselineFromScene(
  selection: InspectorPanelProps["selection"],
  scene: SceneResource | null | undefined,
  forceBuilderMode: boolean,
  fallbackOriginObjectId?: string | null,
): ObjectGeometrySpecDraft {
  const defaultPolygon: readonly PolygonVertexRow[] = [
    createPolygonVertexRow(-50e-9, -30e-9, "vtx-0"),
    createPolygonVertexRow(50e-9, -30e-9, "vtx-1"),
    createPolygonVertexRow(50e-9, 30e-9, "vtx-2"),
    createPolygonVertexRow(-50e-9, 30e-9, "vtx-3"),
  ];

  if (forceBuilderMode || selection.kind === "builder.primitive") {
    const slug = selection.nodeId?.split(":").at(-1) ?? "box";
    const primitiveKind = normalizePrimitiveKind(slug);
    const baseName = resolveDefaultDraftBaseName(selection, primitiveKind);
    const draftName = resolveDraftObjectName(
      selection.label?.trim() || baseName,
      baseName,
      scene,
    );
    return {
      mode: "draft-new",
      objectId: "draft",
      draftName,
      materialRef: null,
      regionName: "",
      primitiveKind,
      symmetryAxis: "z",
      sizeX: 100e-9,
      sizeY: 100e-9,
      sizeZ: 10e-9,
      radius: 50e-9,
      height: 10e-9,
      innerRadius: 20e-9,
      outerRadius: 50e-9,
      bottomRadius: 50e-9,
      topRadius: 25e-9,
      majorRadius: 80e-9,
      minorRadius: 20e-9,
      archProfile: "parabolic_arch",
      length: 500e-9,
      width: 100e-9,
      archHeight: 30e-9,
      z0: 0,
      archRadius: 150e-9,
      archAngleRad: Math.PI / 3,
      polygonVertices: defaultPolygon,
      meshAssetPath: "",
      meshUnitScale: 1e-9,
      translation: [0, 0, 0],
      eulerDeg: [0, 0, 0],
      pivotMode: "centroid",
      pivotCustom: [0, 0, 0],
      uniformScale: true,
      scale: [1, 1, 1],
      csgOperation: "none",
      csgToolObjectId: "",
      csgKeepTool: false,
      preservedComplexCsg: null,
      preservedRawGeometry: null,
      hasRealizedOrDirtyMesh: false,
      meshStatusPill: { tone: "info", label: "New draft" },
    };
  }

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";
  const sceneObj = scene?.objects?.find((o) => o.id === objectId);
  if (!sceneObj) {
    return {
      mode: "missing",
      objectId: objectId || "none",
      draftName: selection.label ?? "Geometry",
      materialRef: null,
      regionName: "",
      primitiveKind: "Box",
      symmetryAxis: "z",
      sizeX: 100e-9,
      sizeY: 100e-9,
      sizeZ: 10e-9,
      radius: 50e-9,
      height: 10e-9,
      innerRadius: 20e-9,
      outerRadius: 50e-9,
      bottomRadius: 50e-9,
      topRadius: 25e-9,
      majorRadius: 80e-9,
      minorRadius: 20e-9,
      archProfile: "parabolic_arch",
      length: 500e-9,
      width: 100e-9,
      archHeight: 30e-9,
      z0: 0,
      archRadius: 150e-9,
      archAngleRad: Math.PI / 3,
      polygonVertices: defaultPolygon,
      meshAssetPath: "",
      meshUnitScale: 1e-9,
      translation: [0, 0, 0],
      eulerDeg: [0, 0, 0],
      pivotMode: "centroid",
      pivotCustom: [0, 0, 0],
      uniformScale: true,
      scale: [1, 1, 1],
      csgOperation: "none",
      csgToolObjectId: "",
      csgKeepTool: false,
      preservedComplexCsg: null,
      preservedRawGeometry: null,
      hasRealizedOrDirtyMesh: false,
      meshStatusPill: { tone: "warn", label: "Not found" },
    };
  }

  const geom = (sceneObj.geometry ?? null) as JsonObject | null;
  const rawParams = geom?.geometry_params;
  const params: Record<string, unknown> =
    rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};
  const primitiveKind = normalizePrimitiveKind(
    typeof geom?.geometry_kind === "string"
      ? geom.geometry_kind
      : typeof geom?.kind === "string"
        ? geom.kind
        : "Box",
  );
  const rawSize = Array.isArray(params.size) ? params.size : null;
  const rawRadii = Array.isArray(params.radii) ? params.radii : null;
  const rawTransform = sceneObj.transform as unknown;
  const tx: Record<string, unknown> =
    rawTransform && typeof rawTransform === "object" && !Array.isArray(rawTransform)
      ? (rawTransform as Record<string, unknown>)
      : {};
  const trArr = Array.isArray(tx.translation) ? tx.translation : [0, 0, 0];
  const scArr = Array.isArray(tx.scale) ? tx.scale : [1, 1, 1];
  const pvArr = Array.isArray(tx.pivot) ? tx.pivot : [0, 0, 0];
  const translation: readonly [number, number, number] = [
    Number(trArr[0]) || 0,
    Number(trArr[1]) || 0,
    Number(trArr[2]) || 0,
  ];
  const pivotVec: readonly [number, number, number] = [
    Number(pvArr[0]) || 0,
    Number(pvArr[1]) || 0,
    Number(pvArr[2]) || 0,
  ];
  const eulerDeg = quatToEulerDeg(
    Array.isArray(tx.rotation_quat) ? (tx.rotation_quat as number[]) : [0, 0, 0, 1],
  );

  let pivotMode: "centroid" | "origin" | "custom";
  if (tx.pivot_mode === "origin" || tx.pivot_mode === "centroid" || tx.pivot_mode === "custom") {
    pivotMode = tx.pivot_mode;
  } else {
    const isZeroPivot = pivotVec.every((v) => Math.abs(v) <= 1e-15);
    const hasNonZeroTranslation = translation.some((v) => Math.abs(v) > 1e-15);
    const matchesNegatedTranslation =
      hasNonZeroTranslation &&
      pivotVec.every(
        (v, idx) =>
          Math.abs(v + translation[idx]!) <= Math.max(1e-15, Math.abs(translation[idx]!) * 1e-9),
      );
    if (matchesNegatedTranslation) {
      pivotMode = "origin";
    } else if (!isZeroPivot) {
      pivotMode = "custom";
    } else if (fallbackOriginObjectId === objectId) {
      pivotMode = "origin";
    } else {
      pivotMode = "centroid";
    }
  }

  const rawVerts = Array.isArray(params.vertices) ? params.vertices : null;
  const parsedVerts: readonly PolygonVertexRow[] =
    rawVerts && rawVerts.length >= 3
      ? rawVerts.map((pair, idx) => {
          const arr = Array.isArray(pair) ? pair : [0, 0];
          return {
            _rowId: `vtx-${objectId}-${idx}`,
            x_m: Number(arr[0]) || 0,
            y_m: Number(arr[1]) || 0,
          };
        })
      : defaultPolygon;

  const csgOpRec = (geom?.csg_operation ?? null) as Record<string, unknown> | null;
  const csgTreeRec = (geom?.csg_tree ?? null) as JsonObject | null;
  const tags = Array.isArray(sceneObj.tags) ? sceneObj.tags : [];
  const hasRealizedOrDirtyMesh =
    tags.includes("mesh:ready") || tags.includes("mesh:dirty") || tags.includes("mesh:building");
  const meshStatusPill = resolveMeshStatusFromObject(sceneObj);

  return {
    mode: "committed",
    objectId,
    draftName: sceneObj.name?.trim() || objectId,
    materialRef:
      typeof sceneObj.material_ref === "string" && sceneObj.material_ref.trim().length > 0
        ? sceneObj.material_ref
        : null,
    regionName: typeof sceneObj.region_name === "string" ? sceneObj.region_name : "",
    primitiveKind,
    symmetryAxis: parseSymmetryAxis(params.axis),
    sizeX:
      typeof rawSize?.[0] === "number"
        ? rawSize[0]
        : typeof rawRadii?.[0] === "number"
          ? rawRadii[0] * 2
          : 100e-9,
    sizeY:
      typeof rawSize?.[1] === "number"
        ? rawSize[1]
        : typeof rawRadii?.[1] === "number"
          ? rawRadii[1] * 2
          : 100e-9,
    sizeZ:
      typeof rawSize?.[2] === "number"
        ? rawSize[2]
        : typeof rawRadii?.[2] === "number"
          ? rawRadii[2] * 2
          : 10e-9,
    radius: typeof params.radius === "number" ? params.radius : 50e-9,
    height: typeof params.height === "number" ? params.height : 10e-9,
    innerRadius: typeof params.inner_radius === "number" ? params.inner_radius : 20e-9,
    outerRadius: typeof params.outer_radius === "number" ? params.outer_radius : 50e-9,
    bottomRadius: typeof params.bottom_radius === "number" ? params.bottom_radius : 50e-9,
    topRadius: typeof params.top_radius === "number" ? params.top_radius : 25e-9,
    majorRadius: typeof params.major_radius === "number" ? params.major_radius : 80e-9,
    minorRadius: typeof params.minor_radius === "number" ? params.minor_radius : 20e-9,
    archProfile:
      params.profile_kind === "circular_arc" || typeof params.arc_radius === "number"
        ? "circular_arc"
        : "parabolic_arch",
    length: typeof params.length === "number" ? params.length : 500e-9,
    width: typeof params.width === "number" ? params.width : 100e-9,
    archHeight: typeof params.arch_height === "number" ? params.arch_height : 30e-9,
    z0: typeof params.z0 === "number" ? params.z0 : 0,
    archRadius: typeof params.arc_radius === "number" ? params.arc_radius : 150e-9,
    archAngleRad: typeof params.arc_angle_rad === "number" ? params.arc_angle_rad : Math.PI / 3,
    polygonVertices: parsedVerts,
    meshAssetPath: typeof params.asset_path === "string" ? params.asset_path : "",
    meshUnitScale: parseImportedMeshUnitScale(params.unit_scale),
    translation,
    eulerDeg,
    pivotMode,
    pivotCustom: pivotMode === "custom" ? pivotVec : [0, 0, 0],
    uniformScale:
      Math.abs((Number(scArr[0]) || 1) - (Number(scArr[1]) || 1)) < 1e-9 &&
      Math.abs((Number(scArr[1]) || 1) - (Number(scArr[2]) || 1)) < 1e-9,
    scale: [Number(scArr[0]) || 1, Number(scArr[1]) || 1, Number(scArr[2]) || 1],
    csgOperation:
      csgOpRec?.kind === "union" ||
      csgOpRec?.kind === "difference" ||
      csgOpRec?.kind === "intersection"
        ? csgOpRec.kind
        : "none",
    csgToolObjectId: typeof csgOpRec?.tool_object_id === "string" ? csgOpRec.tool_object_id : "",
    csgKeepTool: Boolean(csgOpRec?.keep_tool),
    preservedComplexCsg: csgTreeRec,
    preservedRawGeometry: geom,
    hasRealizedOrDirtyMesh,
    meshStatusPill,
  };
}

export function resolveMeshStatusFromObject(sceneObj: SceneObject): {
  tone: InspectorTone;
  label: string;
} {
  const tags = Array.isArray(sceneObj.tags) ? sceneObj.tags : [];
  if (tags.includes("validation:blocked")) {
    return { tone: "err", label: "Validation blocked" };
  }
  if (tags.includes("mesh:building")) {
    return { tone: "live", label: "Mesh building" };
  }
  if (tags.includes("mesh:failed")) {
    return { tone: "err", label: "Mesh failed" };
  }
  if (tags.includes("mesh:dirty")) {
    return { tone: "stale", label: "Mesh stale" };
  }
  if (tags.includes("mesh:ready")) {
    return { tone: "ok", label: "Mesh current" };
  }
  return { tone: "info", label: "Parametric" };
}

function computeDraftSummaryMetrics(draft: ObjectGeometrySpecDraft): {
  spanText: string | null;
  volumeText: string | null;
} {
  switch (draft.primitiveKind) {
    case "Box":
      return {
        spanText: formatSpanAuto([draft.sizeX, draft.sizeY, draft.sizeZ]),
        volumeText: formatVolumeAuto(draft.sizeX * draft.sizeY * draft.sizeZ),
      };
    case "Ellipsoid":
      return {
        spanText: formatSpanAuto([draft.sizeX, draft.sizeY, draft.sizeZ]),
        volumeText: formatVolumeAuto((Math.PI / 6) * draft.sizeX * draft.sizeY * draft.sizeZ),
      };
    case "Cylinder":
      return {
        spanText: formatSpanAuto([2 * draft.radius, 2 * draft.radius, draft.height]),
        volumeText: formatVolumeAuto(Math.PI * draft.radius * draft.radius * draft.height),
      };
    case "Sphere":
      return {
        spanText: formatSpanAuto([2 * draft.radius, 2 * draft.radius, 2 * draft.radius]),
        volumeText: formatVolumeAuto((4 / 3) * Math.PI * Math.pow(draft.radius, 3)),
      };
    case "Tube":
      return {
        spanText: formatSpanAuto([
          2 * draft.outerRadius,
          2 * draft.outerRadius,
          draft.height,
        ]),
        volumeText:
          draft.outerRadius > draft.innerRadius
            ? formatVolumeAuto(
                Math.PI *
                  (draft.outerRadius * draft.outerRadius -
                    draft.innerRadius * draft.innerRadius) *
                  draft.height,
              )
            : null,
      };
    case "Cone":
      return {
        spanText: formatSpanAuto([
          2 * Math.max(draft.bottomRadius, draft.topRadius),
          2 * Math.max(draft.bottomRadius, draft.topRadius),
          draft.height,
        ]),
        volumeText: formatVolumeAuto(
          ((Math.PI * draft.height) / 3) *
            (draft.bottomRadius * draft.bottomRadius +
              draft.bottomRadius * draft.topRadius +
              draft.topRadius * draft.topRadius),
        ),
      };
    case "Torus": {
      const outerD = 2 * (draft.majorRadius + draft.minorRadius);
      return {
        spanText: formatSpanAuto([outerD, outerD, 2 * draft.minorRadius]),
        volumeText: formatVolumeAuto(
          2 * Math.PI * Math.PI * draft.majorRadius * draft.minorRadius * draft.minorRadius,
        ),
      };
    }
    case "ArchWaveguide": {
      const rise =
        draft.archProfile === "circular_arc"
          ? draft.archRadius * (1 - Math.cos(Math.abs(draft.archAngleRad) / 2))
          : draft.archHeight;
      return {
        spanText: formatSpanAuto([draft.length, draft.width, draft.height + rise]),
        volumeText: formatVolumeAuto(draft.length * draft.width * draft.height),
      };
    }
    default:
      return { spanText: null, volumeText: null };
  }
}

/* ── Controlled Polygon Vertex Input (0 defaultValue) ── */

function formatVertexNm(meters: number): string {
  return String(Number((meters * 1e9).toFixed(3)));
}

function PolygonVertexAxisInput({
  ariaLabel,
  valueMeters,
  onChangeMeters,
}: {
  ariaLabel: string;
  valueMeters: number;
  onChangeMeters: (nextMeters: number) => void;
}) {
  const canonicalText = formatVertexNm(valueMeters);
  const [rawText, setRawText] = useState(canonicalText);
  const [prevMeters, setPrevMeters] = useState(valueMeters);
  const [lastCommittedMeters, setLastCommittedMeters] = useState(valueMeters);

  if (!Object.is(valueMeters, prevMeters)) {
    setPrevMeters(valueMeters);
    if (!Object.is(valueMeters, lastCommittedMeters)) {
      setLastCommittedMeters(valueMeters);
      setRawText(canonicalText);
    }
  }

  return (
    <Input
      aria-label={ariaLabel}
      inputMode="decimal"
      spellCheck={false}
      type="text"
      value={rawText}
      onBlur={() => {
        const trimmed = rawText.trim();
        const parsed = trimmed.length > 0 ? Number(trimmed) : Number.NaN;
        if (Number.isFinite(parsed)) {
          const nextMeters = parsed * 1e-9;
          setLastCommittedMeters(nextMeters);
          if (!Object.is(nextMeters, valueMeters)) {
            onChangeMeters(nextMeters);
          }
          setRawText(formatVertexNm(nextMeters));
        } else {
          setRawText(canonicalText);
        }
      }}
      onChange={(event) => {
        const nextText = event.target.value;
        setRawText(nextText);
        const trimmed = nextText.trim();
        const parsed = trimmed.length > 0 ? Number(trimmed) : Number.NaN;
        if (Number.isFinite(parsed)) {
          const nextMeters = parsed * 1e-9;
          setLastCommittedMeters(nextMeters);
          if (!Object.is(nextMeters, valueMeters)) {
            onChangeMeters(nextMeters);
          }
        }
      }}
    />
  );
}

/* ── Panel-Level Live Draft Overlay Publisher (Never Tab-Scoped) ── */

function LiveDraftOverlayPublisher({
  draft,
  baseline,
  invalidFields,
}: {
  draft: ObjectGeometrySpecDraft;
  baseline: ObjectGeometrySpecDraft;
  invalidFields: ReadonlyMap<string, string>;
}) {
  const [lastValidSnapshot, setLastValidSnapshot] = useState<ObjectGeometrySpecDraft>(baseline);
  const [prevDraft, setPrevDraft] = useState<ObjectGeometrySpecDraft>(draft);

  if (draft !== prevDraft) {
    setPrevDraft(draft);
    setLastValidSnapshot((prev) =>
      draft.primitiveKind !== prev.primitiveKind
        ? updateLastValidDraftSnapshot(baseline, draft)
        : updateLastValidDraftSnapshot(prev, draft),
    );
  }

  const overlayDraft = useMemo(
    () =>
      draft.mode === "draft-new"
        ? resolvePreviewOverlayDraft(draft, lastValidSnapshot, invalidFields)
        : null,
    [draft, invalidFields, lastValidSnapshot],
  );

  useEffect(() => {
    if (overlayDraft) {
      primitiveDraftOverlayStore.publish(overlayDraft);
    } else {
      primitiveDraftOverlayStore.clear();
    }
  }, [overlayDraft]);

  useEffect(() => () => primitiveDraftOverlayStore.clear(), []);

  return null;
}

function extractTranslationSIFromSessionDraft(
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

/* ── Shared Geometry Spec Implementation ── */

function SharedGeometrySpecPanel({
  selection,
  forceBuilderMode,
}: InspectorPanelProps & { forceBuilderMode: boolean }) {
  const kernel = useKernel();
  const fallbackEditSession = useMemo(
    () => new ObjectEditSessionController<GeometryObjectDraft>(),
    [],
  );
  const objectEditSession = kernel.objectEditSession ?? fallbackEditSession;
  const editSnapshot = useObjectEditSelector(objectEditSession);

  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const scene = useSceneResource();
  const validation = useGeometryValidationResource();

  const resolveActiveScopeKey = useCallback((): string | null => {
    const commandScope = kernel.commands?.getSessionScopeKey?.() ?? null;
    const identityScope = sessionRequestScopeKey(sessionIdentity) ?? scene.sessionScopeKey ?? null;
    return identityScope ?? commandScope;
  }, [kernel.commands, scene.sessionScopeKey, sessionIdentity]);

  const currentSessionScopeKey = resolveActiveScopeKey();
  const sessionIdentityRef = useRef(sessionIdentity);
  useLayoutEffect(() => {
    sessionIdentityRef.current = sessionIdentity;
  }, [sessionIdentity]);

  const [lastOriginPivotObjectId, setLastOriginPivotObjectId] = useState<string | null>(null);
  const [ownCreatePending, setOwnCreatePending] = useState(false);

  /* ── 409 Revision Conflict State (Derived During Render — Zero Effect Cascades) ── */
  const [revisionConflictPhase, setRevisionConflictPhase] =
    useState<RevisionConflictPhase | null>(null);
  const [conflictBaseRevision, setConflictBaseRevision] = useState<number | null>(null);
  const [refreshSawLoading, setRefreshSawLoading] = useState(false);
  const [prevConflictTargetKey, setPrevConflictTargetKey] = useState<string | null>(null);
  const preConflictSessionBaselineRef = useRef<GeometryObjectDraft | null>(null);

  const baseline = useMemo(
    () =>
      buildBaselineFromScene(
        selection,
        scene.data,
        forceBuilderMode,
        lastOriginPivotObjectId,
      ),
    [forceBuilderMode, lastOriginPivotObjectId, scene.data, selection],
  );

  const canonicalSessionDraft = useMemo(
    () =>
      baseline.mode === "committed"
        ? resolveGeometryObjectDraft(selection, scene.data)
        : null,
    [baseline.mode, scene.data, selection],
  );

  const sessionTargetKey = useMemo(
    () =>
      canonicalSessionDraft
        ? geometryObjectEditSessionTargetKey(currentSessionScopeKey, canonicalSessionDraft)
        : null,
    [canonicalSessionDraft, currentSessionScopeKey],
  );

  if (sessionTargetKey !== prevConflictTargetKey) {
    setPrevConflictTargetKey(sessionTargetKey);
    if (revisionConflictPhase !== null) setRevisionConflictPhase(null);
    if (conflictBaseRevision !== null) setConflictBaseRevision(null);
    if (refreshSawLoading) setRefreshSawLoading(false);
  }

  if (revisionConflictPhase === "refreshing") {
    if (scene.status === "loading" || scene.status === "stale") {
      if (!refreshSawLoading) setRefreshSawLoading(true);
    } else if (scene.status === "error") {
      setRevisionConflictPhase("refresh-error");
    } else if (scene.status === "ready") {
      const nextRev = typeof scene.data?.revision === "number" ? scene.data.revision : null;
      if (refreshSawLoading || (nextRev !== null && nextRev !== conflictBaseRevision)) {
        setRevisionConflictPhase("refetched");
      }
    }
  }

  const sessionMatchesTarget =
    sessionTargetKey !== null && editSnapshot.identity?.targetKey === sessionTargetKey;
  const editIdentity = sessionMatchesTarget ? editSnapshot.identity : null;
  const ownObjectApplyPending = Boolean(
    sessionMatchesTarget && editSnapshot.applyOperationId !== null,
  );
  const sceneWritePending = objectEditSession.hasPendingWrite(currentSessionScopeKey);
  const placementGestureActive = objectEditSession.hasActiveGesture(currentSessionScopeKey);
  const sceneMutationLockReason = placementGestureActive
    ? "Finish or cancel the active placement gesture before applying or reverting scene changes."
    : sceneWritePending && !ownObjectApplyPending && !ownCreatePending
      ? "Another scene-changing action is pending in this session."
      : null;

  useEffect(() => {
    if (revisionConflictPhase === null) {
      preConflictSessionBaselineRef.current = null;
    }
  }, [revisionConflictPhase]);

  const validationMessages = useMemo(
    () =>
      baseline.mode === "committed"
        ? summarizeGeometryValidationMessages(validation.data, baseline.objectId)
        : [],
    [baseline.mode, baseline.objectId, validation.data],
  );

  const otherObjects = useMemo(
    () =>
      (scene.data?.objects ?? [])
        .filter((o) => o.id !== baseline.objectId && o.role !== "airbox" && o.role !== "air")
        .map((o) => ({
          value: o.id,
          label: `${o.name ?? o.id} (${o.id})`,
        })),
    [baseline.objectId, scene.data?.objects],
  );

  const materialOptions = useMemo(
    () =>
      (scene.data?.materials ?? []).map((mat) => ({
        id: mat.id,
        label: mat.name?.trim() ? `${mat.name} (${mat.id})` : mat.id,
      })),
    [scene.data?.materials],
  );

  const createDraftSlugId = useCallback((draft: ObjectGeometrySpecDraft) => {
    const slug = draft.draftName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${slug || draft.primitiveKind.toLowerCase()}-${Date.now().toString(36)}`;
  }, []);

  const lastSyncedEditVersionRef = useRef<number>(-1);
  const lastSyncedTargetKeyRef = useRef<string | null>(null);
  const requestApplyRef = useRef<() => Promise<boolean>>(async () => false);

  const handleRefetchConflict = useCallback(() => {
    setRefreshSawLoading(false);
    setRevisionConflictPhase("refreshing");
    scene.refetch?.();
  }, [scene]);

  const handleRebaseConflict = useCallback(() => {
    if (editIdentity && canonicalSessionDraft && preConflictSessionBaselineRef.current) {
      const snap = objectEditSession.getSnapshot();
      const currentSessionDraft = snap.draft ?? canonicalSessionDraft;
      const rebasedSessionDraft = rebaseGeometryObjectDraft(
        currentSessionDraft,
        canonicalDraftInSelectedUnits(canonicalSessionDraft, currentSessionDraft),
        preConflictSessionBaselineRef.current,
      );
      objectEditSession.updateDraft(editIdentity, () => rebasedSessionDraft);
      lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;
    }
    setRevisionConflictPhase("rebased");
  }, [canonicalSessionDraft, editIdentity, objectEditSession]);

  const spec = useMemo<InspectorSpec<ObjectGeometrySpecDraft>>(
    () => ({
      id: forceBuilderMode ? "builder.primitive" : "object.geometry",
      header: {
        breadcrumbs:
          baseline.mode === "draft-new"
            ? [
                {
                  id: "objects",
                  label: "Objects",
                  selection: buildRootSelection("objects.root", "model:objects", "Objects"),
                },
                { id: "draft", label: baseline.draftName },
              ]
            : [
                {
                  id: "objects",
                  label: "Objects",
                  selection: buildRootSelection("objects.root", "model:objects", "Objects"),
                },
                {
                  id: "object",
                  label: baseline.draftName,
                  selection: buildObjectSelection(
                    baseline.objectId,
                    "object.root",
                    baseline.draftName,
                  ),
                },
                { id: "geometry", label: "Geometry" },
              ],
        canFitView: baseline.mode === "committed",
        searchable: true,
      },
      identity: {
        domain: "geometry",
        icon: Shapes,
        title: (draft) =>
          draft.mode === "draft-new" ? draft.draftName : `${draft.primitiveKind} Geometry`,
        renameFieldKey: baseline.mode === "draft-new" ? "draftName" : undefined,
        kindLabel:
          baseline.mode === "draft-new" ? "Primitive builder draft" : "Parametric solid geometry",
        entityId: baseline.mode === "committed" ? baseline.objectId : undefined,
        statePill: (draft) => draft.meshStatusPill,
      },
      facts: (draft): readonly InspectorFact[] => {
        const metrics = computeDraftSummaryMetrics(draft);
        return [
          { id: "kind", label: "Primitive", value: draft.primitiveKind },
          { id: "span", label: "Bounding span", value: metrics.spanText },
          { id: "volume", label: "Volume", value: metrics.volumeText },
        ];
      },
      modeTabs: [
        { id: "shape", label: "Shape", icon: Shapes },
        { id: "transform", label: "Transform", icon: Move3d },
        { id: "csg", label: "Boolean CSG", icon: Combine },
      ],
      notices: (draft): readonly InspectorNotice<ObjectGeometrySpecDraft>[] => {
        const list: InspectorNotice<ObjectGeometrySpecDraft>[] = [];
        if (revisionConflictPhase !== null) {
          list.push({
            id: "scene-revision-conflict",
            tone: revisionConflictPhase === "rebased" ? "warn" : "err",
            title: "Scene revision conflict",
            text:
              revisionConflictPhase === "rebased"
                ? "Draft rebased onto the latest scene revision. Click Retry Apply to commit."
                : revisionConflictPhase === "refetched"
                  ? "Latest scene fetched. Click Rebase Draft to merge your edits onto the updated revision."
                  : revisionConflictPhase === "refresh-error"
                    ? "Scene refetch failed. Retry Refetch Scene before rebasing."
                    : "The scene changed while this geometry edit was staged. Refetch and rebase before retrying.",
            quickFix:
              revisionConflictPhase === "conflict" || revisionConflictPhase === "refresh-error"
                ? {
                    label: "Refetch Scene",
                    onApply: () => handleRefetchConflict(),
                  }
                : revisionConflictPhase === "refetched"
                  ? {
                      label: "Rebase Draft",
                      onApply: () => handleRebaseConflict(),
                    }
                  : revisionConflictPhase === "rebased"
                    ? {
                        label: "Retry Apply",
                        onApply: () => {
                          void requestApplyRef.current();
                        },
                      }
                    : undefined,
          });
        }
        if (draft.mode === "committed" && draft.hasRealizedOrDirtyMesh) {
          list.push({
            id: "mesh-stale-warning",
            tone: "warn",
            title: "Geometry edits invalidate realized mesh",
            text: "Applying new dimensions or transforms marks the object mesh stale until rebuilt.",
          });
        }
        for (const [idx, msg] of validationMessages.entries()) {
          list.push({
            id: `geom-validation-${idx}`,
            tone: "err",
            title: "Geometry validation diagnostic",
            text: msg,
          });
        }
        return list;
      },
      sections: [
        /* ── CONFLICT RESOLUTION BAR (ALL TABS WHEN ACTIVE) ── */
        {
          id: "geometry-revision-conflict-actions",
          title: "Revision conflict recovery",
          icon: Shapes,
          defaultOpen: true,
          showWhen: () => revisionConflictPhase !== null,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div
                  className="flex flex-wrap gap-1.5"
                  data-revision-conflict="true"
                >
                  <Button
                    disabled={
                      revisionConflictPhase !== "conflict" &&
                      revisionConflictPhase !== "refresh-error"
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={handleRefetchConflict}
                  >
                    Refetch Scene
                  </Button>
                  <Button
                    disabled={revisionConflictPhase !== "refetched"}
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={handleRebaseConflict}
                  >
                    Rebase Draft
                  </Button>
                  <Button
                    disabled={revisionConflictPhase !== "rebased"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => {
                      void requestApplyRef.current();
                    }}
                  >
                    Retry Apply
                  </Button>
                </div>
              ),
            },
          ],
        },

        /* ── TAB 1: SHAPE ── */
        {
          id: "geometry-shape-kind",
          modeTabId: "shape",
          title: "Primitive family",
          icon: Shapes,
          defaultOpen: true,
          summary: (d) => d.primitiveKind,
          rows: [
            {
              key: "draftName",
              type: "text",
              label: "New object name",
              showWhen: (d) => d.mode === "draft-new",
              validate: (val) => (val.trim().length === 0 ? "Object name is required." : null),
            },
            {
              key: "materialRef",
              type: "reference",
              label: "Material",
              targetKindLabel: "Material",
              showWhen: (d) => d.mode === "draft-new",
              allowNone: { label: "Unassigned" },
              options: () => materialOptions,
            },
            {
              key: "regionName",
              type: "text",
              label: "Region",
              placeholder: "Optional region name",
              showWhen: (d) => d.mode === "draft-new",
            },
            {
              key: "primitiveKind",
              type: "select",
              label: "Primitive kind",
              structural: true,
              options: [
                { value: "Box", label: "Box (rectangular prism)", group: "Analytic solids" },
                { value: "Cylinder", label: "Cylinder / disk", group: "Analytic solids" },
                { value: "Ellipsoid", label: "Ellipsoid", group: "Analytic solids" },
                { value: "Sphere", label: "Sphere", group: "Analytic solids" },
                { value: "Tube", label: "Tube (hollow cylinder / ring)", group: "Shells & rings" },
                { value: "Cone", label: "Cone / truncated frustum", group: "Shells & rings" },
                { value: "Torus", label: "Torus", group: "Shells & rings" },
                {
                  value: "ArchWaveguide",
                  label: "Arch waveguide (3D curved strip)",
                  group: "Waveguides & extrusions",
                },
                {
                  value: "PolygonExtrusion",
                  label: "Polygon extrusion (2D contour)",
                  group: "Waveguides & extrusions",
                },
                {
                  value: "ImportedMesh",
                  label: "Imported surface / CAD mesh",
                  group: "External assets",
                },
              ],
            },
            {
              key: "symmetryAxis",
              type: "segmented",
              label: "Principal axis",
              showWhen: (d) =>
                d.primitiveKind === "Cylinder" ||
                d.primitiveKind === "Tube" ||
                d.primitiveKind === "Cone" ||
                d.primitiveKind === "Torus" ||
                d.primitiveKind === "PolygonExtrusion",
              options: [
                { value: "x", label: "X" },
                { value: "y", label: "Y" },
                { value: "z", label: "Z" },
              ],
            },
          ],
        },
        {
          id: "geometry-shape-dimensions",
          modeTabId: "shape",
          title: "Parametric dimensions",
          icon: Box,
          defaultOpen: true,
          rows: [
            /* Box & Ellipsoid */
            {
              key: "sizeX",
              type: "quantity",
              label: "Extent X",
              symbol: <>L<sub>x</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
              validate: (v) => (v > 0 ? null : "Extent X must be strictly positive."),
            },
            {
              key: "sizeY",
              type: "quantity",
              label: "Extent Y",
              symbol: <>L<sub>y</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
              validate: (v) => (v > 0 ? null : "Extent Y must be strictly positive."),
            },
            {
              key: "sizeZ",
              type: "quantity",
              label: "Thickness Z",
              symbol: <>L<sub>z</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
              validate: (v) => (v > 0 ? null : "Thickness Z must be strictly positive."),
            },

            /* Cylinder & Sphere */
            {
              key: "radius",
              type: "quantity",
              label: "Radius",
              symbol: <>R</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Cylinder" || d.primitiveKind === "Sphere",
              validate: (v) => (v > 0 ? null : "Radius R must be strictly positive."),
            },
            {
              key: "height",
              type: "quantity",
              label: "Height / thickness",
              symbol: <>h</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.primitiveKind === "Cylinder" ||
                d.primitiveKind === "Tube" ||
                d.primitiveKind === "Cone" ||
                d.primitiveKind === "ArchWaveguide" ||
                d.primitiveKind === "PolygonExtrusion",
              validate: (v) => (v > 0 ? null : "Height h must be strictly positive."),
            },

            /* Tube */
            {
              key: "innerRadius",
              type: "quantity",
              label: "Inner radius",
              symbol: <>R<sub>in</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Tube",
              validate: (v, d) => validateTubeRadii(v, d.outerRadius),
            },
            {
              key: "outerRadius",
              type: "quantity",
              label: "Outer radius",
              symbol: <>R<sub>out</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Tube",
              validate: (v, d) => validateTubeRadii(d.innerRadius, v),
            },

            /* Cone */
            {
              key: "bottomRadius",
              type: "quantity",
              label: "Bottom radius",
              symbol: <>R<sub>1</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              showWhen: (d) => d.primitiveKind === "Cone",
              validate: (v, d) =>
                v < 0
                  ? "Bottom radius must be non-negative."
                  : v + d.topRadius <= 0
                    ? "At least one cone radius must be strictly positive."
                    : null,
            },
            {
              key: "topRadius",
              type: "quantity",
              label: "Top radius",
              symbol: <>R<sub>2</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              showWhen: (d) => d.primitiveKind === "Cone",
              validate: (v, d) =>
                v < 0
                  ? "Top radius must be non-negative."
                  : d.bottomRadius + v <= 0
                    ? "At least one cone radius must be strictly positive."
                    : null,
            },

            /* Torus */
            {
              key: "majorRadius",
              type: "quantity",
              label: "Major ring radius",
              symbol: <>R<sub>maj</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Torus",
              validate: (v, d) => validateTorusRadii(v, d.minorRadius),
            },
            {
              key: "minorRadius",
              type: "quantity",
              label: "Minor tube radius",
              symbol: <>r<sub>min</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Torus",
              validate: (v, d) => validateTorusRadii(d.majorRadius, v),
            },

            /* ArchWaveguide */
            {
              key: "archProfile",
              type: "segmented",
              label: "Arch profile",
              structural: true,
              showWhen: (d) => d.primitiveKind === "ArchWaveguide",
              options: [
                { value: "parabolic_arch", label: "Parabolic arch" },
                { value: "circular_arc", label: "Circular arc" },
              ],
            },
            {
              key: "length",
              type: "quantity",
              label: "Span length",
              symbol: <>L</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "ArchWaveguide",
              validate: (v, d) =>
                validateArchWaveguide({ ...d, length: v }).errors.length ?? null,
            },
            {
              key: "width",
              type: "quantity",
              label: "Strip width",
              symbol: <>w</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "ArchWaveguide",
              validate: (v, d) => {
                const res = validateArchWaveguide({ ...d, width: v });
                return res.errors.width ?? res.errors.archRadius ?? null;
              },
            },
            {
              key: "archHeight",
              type: "quantity",
              label: "Apex arch height",
              symbol: <>h<sub>arch</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              showWhen: (d) =>
                d.primitiveKind === "ArchWaveguide" && d.archProfile === "parabolic_arch",
              validate: (v, d) =>
                validateArchWaveguide({ ...d, archHeight: v }).errors.archHeight ?? null,
            },
            {
              key: "archRadius",
              type: "quantity",
              label: "Centerline arc radius",
              symbol: <>R<sub>arc</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.primitiveKind === "ArchWaveguide" && d.archProfile === "circular_arc",
              validate: (v, d) =>
                validateArchWaveguide({ ...d, archRadius: v }).errors.archRadius ?? null,
            },
            {
              key: "archAngleRad",
              type: "quantity",
              label: "Opening angle",
              symbol: <>&Delta;&theta;</>,
              units: ANGLE_UNITS,
              defaultDisplayUnit: "deg",
              showWhen: (d) =>
                d.primitiveKind === "ArchWaveguide" && d.archProfile === "circular_arc",
              validate: (v, d) =>
                validateArchWaveguide({ ...d, archAngleRad: v }).errors.archAngleRad ?? null,
            },
            {
              key: "z0",
              type: "quantity",
              label: "Base elevation",
              symbol: <>z<sub>0</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.primitiveKind === "ArchWaveguide",
            },
            {
              type: "readonly",
              label: "Derived apex rise",
              mono: true,
              showWhen: (d) =>
                d.primitiveKind === "ArchWaveguide" && d.archProfile === "circular_arc",
              format: (d) => {
                const rise = d.archRadius * (1 - Math.cos(Math.abs(d.archAngleRad) / 2));
                return formatLengthAuto(rise) ?? "0 nm";
              },
            },

            /* PolygonExtrusion — Single Controlled Vertex Editor */
            {
              key: "polygonVertices",
              type: "custom",
              label: "2D contour vertices (nm)",
              wide: true,
              showWhen: (d) => d.primitiveKind === "PolygonExtrusion",
              validate: (verts) => validateSimplePolygon(verts as readonly PolygonVertexRow[]),
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="polygon-vertex-editor">
                  {ctx.draft.polygonVertices.map((vtx, idx) => (
                    <div key={vtx._rowId} className="flex items-center gap-1.5">
                      <span className="w-6 font-mono text-xs text-[var(--fm-text-muted)]">
                        V{idx + 1}
                      </span>
                      <PolygonVertexAxisInput
                        ariaLabel={`Vertex ${idx + 1} X (nm)`}
                        valueMeters={vtx.x_m}
                        onChangeMeters={(nextXm) =>
                          ctx.setField(
                            "polygonVertices",
                            ctx.draft.polygonVertices.map((item) =>
                              item._rowId === vtx._rowId ? { ...item, x_m: nextXm } : item,
                            ),
                          )
                        }
                      />
                      <PolygonVertexAxisInput
                        ariaLabel={`Vertex ${idx + 1} Y (nm)`}
                        valueMeters={vtx.y_m}
                        onChangeMeters={(nextYm) =>
                          ctx.setField(
                            "polygonVertices",
                            ctx.draft.polygonVertices.map((item) =>
                              item._rowId === vtx._rowId ? { ...item, y_m: nextYm } : item,
                            ),
                          )
                        }
                      />
                      <Button
                        aria-label={`Remove vertex ${idx + 1}`}
                        disabled={ctx.draft.polygonVertices.length <= 3}
                        size="icon"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          ctx.setField(
                            "polygonVertices",
                            ctx.draft.polygonVertices.filter((item) => item._rowId !== vtx._rowId),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" size={12} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const last = ctx.draft.polygonVertices.at(-1);
                      ctx.setField("polygonVertices", [
                        ...ctx.draft.polygonVertices,
                        createPolygonVertexRow((last?.x_m ?? 0) + 20e-9, last?.y_m ?? 0),
                      ]);
                    }}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Polygon Vertex</span>
                  </Button>
                </div>
              ),
            },

            /* ImportedMesh */
            {
              key: "meshAssetPath",
              type: "expression",
              label: "Surface mesh asset ID / path",
              placeholder: "assets/waveguide_manifold.stl",
              showWhen: (d) => d.primitiveKind === "ImportedMesh",
              validate: (v) =>
                v.trim().length === 0 ? "Provide a session mesh asset identifier or path." : null,
            },
            {
              key: "meshUnitScale",
              type: "quantity",
              label: "Coordinate unit scale",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "ImportedMesh",
              validate: (v) =>
                Number.isFinite(v) && v > 0
                  ? null
                  : "Coordinate unit scale must be strictly positive.",
            },
          ],
        },

        /* ── TAB 2: TRANSFORM ── */
        {
          id: "geometry-transform-placement",
          modeTabId: "transform",
          title: "Spatial placement & orientation",
          icon: Move3d,
          defaultOpen: true,
          rows: [
            {
              key: "translation",
              type: "vector3",
              label: "Center translation",
              symbol: <>r<sub>0</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
            },
            {
              key: "eulerDeg",
              type: "vector3",
              label: "Rotation (Euler XYZ)",
              symbol: <>&theta;</>,
              unitSuffix: "\u00b0",
              axisPresets: true,
            },
            {
              key: "pivotMode",
              type: "segmented",
              label: "Rotation & scale pivot",
              structural: true,
              options: [
                { value: "centroid", label: "Centroid" },
                { value: "origin", label: "World origin" },
                { value: "custom", label: "Custom" },
              ],
            },
            {
              key: "pivotCustom",
              type: "vector3",
              label: "Custom pivot coordinates",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.pivotMode === "custom",
            },
          ],
        },
        {
          id: "geometry-transform-scale",
          modeTabId: "transform",
          title: "Dimensionless scale multiplier",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              key: "uniformScale",
              type: "switch",
              label: "Uniform aspect lock",
            },
            {
              key: "scale",
              type: "vector3",
              label: "Scale factors (sx, sy, sz)",
              validate: (vec) =>
                vec.some((c) => !Number.isFinite(c) || c <= 0)
                  ? "All scale factors must be strictly positive."
                  : null,
            },
          ],
          footer: (ctx) => {
            const bakeCheck = canBakeScaleIntoDraft(ctx.draft);
            const bakeButton = (
              <Button
                disabled={!bakeCheck.ok}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  if (!bakeCheck.ok) return;
                  ctx.patchDraft(bakeScaleIntoDraft(ctx.draft));
                }}
              >
                Bake Scale into Dimensions
              </Button>
            );
            return (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {bakeCheck.ok ? (
                    bakeButton
                  ) : (
                    <DisabledReason reason={bakeCheck.reason}>
                      {bakeButton}
                    </DisabledReason>
                  )}
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => ctx.setField("scale", [1, 1, 1])}
                  >
                    Reset Scale [1, 1, 1]
                  </Button>
                </div>
                {!bakeCheck.ok && ctx.draft.primitiveKind === "ImportedMesh" ? (
                  <p
                    className="text-xs text-[var(--fm-text-muted)]"
                    data-slot="imported-mesh-bake-scale-hint"
                  >
                    {bakeCheck.reason}
                  </p>
                ) : null}
              </div>
            );
          },
        },

        /* ── TAB 3: BOOLEAN CSG ── */
        {
          id: "geometry-csg",
          modeTabId: "csg",
          title: "Constructive solid geometry (CSG)",
          icon: Combine,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Authored CSG tree",
              mono: true,
              showWhen: (d) => Boolean(d.preservedComplexCsg),
              format: () => "Multi-node CSG AST preserved losslessly",
            },
            {
              key: "csgOperation",
              type: "segmented",
              label: "Boolean operation",
              structural: true,
              options: [
                { value: "none", label: "Primitive" },
                { value: "union", label: "Union" },
                { value: "difference", label: "Subtract" },
                { value: "intersection", label: "Intersect" },
              ],
            },
            {
              key: "csgToolObjectId",
              type: "select",
              label: "Tool object B",
              showWhen: (d) => d.csgOperation !== "none",
              options:
                otherObjects.length > 0
                  ? otherObjects
                  : [
                      {
                        value: "",
                        label: "No secondary objects available",
                        disabledReason: "Create a second object to combine via Boolean CSG.",
                      },
                    ],
              validate: (val, d) =>
                d.csgOperation !== "none" && !val.trim()
                  ? "Select a tool object B for the Boolean CSG operation."
                  : null,
            },
            {
              key: "csgKeepTool",
              type: "switch",
              label: "Retain tool object in scene",
              showWhen: (d) => d.csgOperation !== "none",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => d.mode === "draft-new",
        cleanMessage: (d) =>
          d.mode === "draft-new"
            ? "Adjust dimensions and click Apply to create the scene object"
            : "Parametric geometry matches committed SceneDocument",
        lockReason: (d) => {
          if (d.mode === "missing") {
            return "Select an existing object or start a primitive draft.";
          }
          if (sceneMutationLockReason) {
            return sceneMutationLockReason;
          }
          if (revisionConflictPhase !== null && revisionConflictPhase !== "rebased") {
            return "Resolve the scene revision conflict before applying this draft.";
          }
          return null;
        },
        onRevert: () => {
          setRevisionConflictPhase(null);
          setConflictBaseRevision(null);
          setRefreshSawLoading(false);
          preConflictSessionBaselineRef.current = null;
          if (editIdentity && canonicalSessionDraft) {
            const currentDraft = objectEditSession.getSnapshot().draft ?? canonicalSessionDraft;
            objectEditSession.reset(
              editIdentity,
              canonicalDraftInSelectedUnits(canonicalSessionDraft, currentDraft),
            );
            lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;
          }
        },
        onApply: async (draft) => {
          const geometry = serializeGeometryPayload(draft);
          const transform = serializeTransformPayload(draft);
          const capturedScopeKey = resolveActiveScopeKey();
          const capturedCommandScopeKey = kernel.commands?.getSessionScopeKey?.();
          const historyGeneration = kernel.authoringHistory?.getGeneration?.();
          const isCurrentSessionScope = () => {
            const activeIdentityScope =
              sessionRequestScopeKey(sessionIdentityRef.current) ?? scene.sessionScopeKey ?? null;
            const activeCommandScope = kernel.commands?.getSessionScopeKey?.();
            const activeScope = activeIdentityScope ?? activeCommandScope ?? null;
            if (activeScope !== capturedScopeKey) return false;
            if (
              capturedCommandScopeKey !== undefined &&
              activeCommandScope !== undefined &&
              activeCommandScope !== capturedCommandScopeKey
            ) {
              return false;
            }
            return (
              historyGeneration === undefined ||
              kernel.authoringHistory?.getGeneration?.() === historyGeneration
            );
          };

          const historyContext = {
            api: kernel.api,
            authoringHistory: kernel.authoringHistory,
            layout: kernel.layout,
            resourceData: { [MODEL_SCENE_PATH]: scene.data },
            selection: kernel.selection,
            sessionScopeKey: capturedScopeKey,
            isCurrentSessionScope,
          };
          const requestOptions = capturedScopeKey
            ? { sessionScopeKey: capturedScopeKey }
            : undefined;
          const sceneRevision =
            typeof scene.data?.revision === "number" && Number.isFinite(scene.data.revision)
              ? scene.data.revision
              : null;

          if (draft.mode === "draft-new") {
            const newId = createDraftSlugId(draft);
            const baseName = resolveDefaultDraftBaseName(selection, draft.primitiveKind);
            const createName = resolveDraftObjectName(
              draft.draftName.trim() || newId,
              baseName,
              scene.data,
            );
            const optionalMaterialRef =
              draft.materialRef &&
              draft.materialRef.trim().length > 0 &&
              draft.materialRef.trim() !== "unassigned"
                ? draft.materialRef.trim()
                : undefined;
            const optionalRegionName =
              draft.regionName.trim().length > 0 && draft.regionName.trim() !== "unassigned"
                ? draft.regionName.trim()
                : undefined;

            const reservation = objectEditSession.beginSceneMutation(capturedScopeKey, newId);
            if (reservation === null) {
              throw new Error(
                objectEditSession.hasActiveGesture(capturedScopeKey)
                  ? "Finish or cancel the active placement gesture before applying scene changes."
                  : "Another scene-changing action is pending in this session.",
              );
            }
            setOwnCreatePending(true);
            try {
              let selectedCreatedObject = false;
              const created = await runAuthoringMutationWithHistory(
                historyContext,
                `Create ${createName}`,
                async ({ baseRevision }) => {
                  const response = await createObjectTransaction(
                    kernel.api,
                    {
                      base_revision: baseRevision ?? sceneRevision,
                      geometry,
                      ...(optionalMaterialRef ? { material_ref: optionalMaterialRef } : {}),
                      name: createName,
                      object_id: newId,
                      ...(optionalRegionName ? { region_name: optionalRegionName } : {}),
                      transform,
                    },
                    requestOptions,
                  );
                  if (isCurrentSessionScope()) {
                    kernel.selection.set(
                      buildObjectSelection(newId, "object.root", createName),
                      "geometry-authoring",
                    );
                    selectedCreatedObject = true;
                  }
                  return response;
                },
                undefined,
                {
                  ...(sceneRevision !== null ? { expectedSceneRevision: sceneRevision } : {}),
                  captureWorkspaceStateAfter: () => selectedCreatedObject,
                },
              );

              if (!isCurrentSessionScope()) return false;
              const rev = acknowledgedAuthoringSceneRevision(created);
              setLastOriginPivotObjectId(draft.pivotMode === "origin" ? newId : null);
              setRevisionConflictPhase(null);
              setConflictBaseRevision(null);
              primitiveDraftOverlayStore.clear();
              publishCommittedSceneResource(
                kernel.resources,
                created.committed_scene,
                rev,
                undefined,
                false,
                capturedScopeKey,
                kernel.api.resourceCacheScope,
              );
              invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
              return true;
            } catch (error) {
              if (isPrimitiveDraftRevisionConflict(error)) {
                setConflictBaseRevision(sceneRevision);
                setRefreshSawLoading(false);
                setRevisionConflictPhase("conflict");
              }
              throw error;
            } finally {
              setOwnCreatePending(false);
              objectEditSession.endSceneMutation(reservation);
            }
          }

          /* ── Committed object.geometry Apply ── */
          if (!editIdentity) {
            throw new Error("Geometry edit session is not ready. Try again.");
          }
          objectEditSession.updateDraft(editIdentity, (current) =>
            ([0, 1, 2] as const).reduce(
              (next, axis) =>
                updateQuantityFieldSI(next, `translation.${axis}`, draft.translation[axis]),
              current,
            ),
          );
          lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;

          const operation = objectEditSession.beginApply(editIdentity);
          if (!operation) {
            throw new Error(
              objectEditSession.hasActiveGesture(capturedScopeKey)
                ? "Finish or cancel the active placement gesture before applying scene changes."
                : "Another scene-changing action is pending in this session.",
            );
          }

          try {
            const response = await runAuthoringMutationWithHistory(
              historyContext,
              `Edit geometry and placement ${draft.draftName}`,
              ({ baseRevision }) =>
                patchObjectGeometryTransaction(
                  kernel.api,
                  draft.objectId,
                  {
                    base_revision: baseRevision ?? sceneRevision,
                    geometry,
                    transform,
                  },
                  requestOptions,
                ),
              undefined,
              sceneRevision !== null ? { expectedSceneRevision: sceneRevision } : undefined,
            );

            if (!isCurrentSessionScope()) {
              objectEditSession.reject(operation);
              return false;
            }

            const rev = acknowledgedAuthoringSceneRevision(response);
            const hasCommittedObjectsArray = Array.isArray(response.committed_scene?.objects);
            const resolvedCanonicalDraft = hasCommittedObjectsArray
              ? resolveCommittedGeometryObjectDraft(
                  response.committed_scene,
                  operation.identity.objectId,
                )
              : {
                  ...operation.submittedDraft,
                  baseRevision: rev,
                };
            if (!resolvedCanonicalDraft) {
              objectEditSession.reject(operation);
              throw new Error("The acknowledged object is missing from the committed scene.");
            }
            const acknowledged = objectEditSession.acknowledge(
              operation,
              {
                ...resolvedCanonicalDraft,
                baseRevision: rev,
              },
              reconcileObjectEditAck,
              { reconcileUnchangedDraft: true },
            );
            if (!acknowledged) return false;
            lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;

            setLastOriginPivotObjectId(draft.pivotMode === "origin" ? draft.objectId : null);
            setRevisionConflictPhase(null);
            setConflictBaseRevision(null);
            preConflictSessionBaselineRef.current = null;
            publishCommittedSceneResource(
              kernel.resources,
              response.committed_scene,
              rev,
              undefined,
              false,
              capturedScopeKey,
              kernel.api.resourceCacheScope,
            );
            invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
            return true;
          } catch (error) {
            objectEditSession.reject(operation);
            if (isPrimitiveDraftRevisionConflict(error)) {
              preConflictSessionBaselineRef.current = canonicalSessionDraft;
              setConflictBaseRevision(sceneRevision);
              setRefreshSawLoading(false);
              setRevisionConflictPhase("conflict");
            }
            throw error;
          }
        },
      },
    }),
    [
      baseline.draftName,
      baseline.mode,
      baseline.objectId,
      canonicalSessionDraft,
      createDraftSlugId,
      editIdentity,
      forceBuilderMode,
      handleRebaseConflict,
      handleRefetchConflict,
      kernel.api,
      kernel.authoringHistory,
      kernel.commands,
      kernel.layout,
      kernel.resources,
      kernel.selection,
      materialOptions,
      objectEditSession,
      otherObjects,
      resolveActiveScopeKey,
      revisionConflictPhase,
      scene.data,
      scene.sessionScopeKey,
      sceneMutationLockReason,
      selection,
      validationMessages,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, baseline);

  useLayoutEffect(() => {
    requestApplyRef.current = controller.requestApply;
  }, [controller.requestApply]);

  /* ── Activate & Reconcile objectEditSession + Sync 3D Gizmo Translation Into Controller ── */
  const controllerDraftRef = useRef(controller.draft);
  useLayoutEffect(() => {
    controllerDraftRef.current = controller.draft;
  }, [controller.draft]);

  useLayoutEffect(() => {
    if (!canonicalSessionDraft || !sessionTargetKey) return;
    const identity = objectEditSession.activate(
      {
        objectId: canonicalSessionDraft.objectId,
        sessionScopeKey: currentSessionScopeKey,
        targetKey: sessionTargetKey,
      },
      canonicalSessionDraft,
    );
    const currentSnap = objectEditSession.getSnapshot();
    if (
      !Number.isFinite(canonicalSessionDraft.baseRevision) ||
      currentSnap.draft?.baseRevision !== canonicalSessionDraft.baseRevision
    ) {
      objectEditSession.refreshCanonical(
        identity,
        canonicalDraftInSelectedUnits(
          canonicalSessionDraft,
          currentSnap.draft ?? canonicalSessionDraft,
        ),
        rebaseDirtyDraftOntoUnchangedObject,
      );
    }

    const latestSnap = objectEditSession.getSnapshot();
    if (
      latestSnap.identity?.draftId === identity.draftId &&
      latestSnap.draft &&
      latestSnap.draft.mode === "committed"
    ) {
      const targetChanged = lastSyncedTargetKeyRef.current !== sessionTargetKey;
      const versionChanged = latestSnap.editVersion !== lastSyncedEditVersionRef.current;
      if (targetChanged || versionChanged) {
        lastSyncedTargetKeyRef.current = sessionTargetKey;
        lastSyncedEditVersionRef.current = latestSnap.editVersion;
        const sessionTranslation = extractTranslationSIFromSessionDraft(latestSnap.draft);
        if (
          sessionTranslation &&
          !vec3ApproxEqual(sessionTranslation, controllerDraftRef.current.translation)
        ) {
          controller.setField("translation", sessionTranslation);
        }
      }
    }
  }, [
    canonicalSessionDraft,
    controller,
    currentSessionScopeKey,
    editSnapshot.editVersion,
    objectEditSession,
    sessionTargetKey,
  ]);

  /* ── Sync Inspector Dirty Flag Into objectEditSession (Compute & Delete Guards) ── */
  useEffect(() => {
    if (!editIdentity || baseline.mode !== "committed") return;
    const snap = objectEditSession.getSnapshot();
    if (snap.editVersion !== lastSyncedEditVersionRef.current) return;
    objectEditSession.setDirty(editIdentity, controller.dirty);
  }, [baseline.mode, controller.dirty, editIdentity, objectEditSession]);

  /* ── Coupled Field Change Handler (uniformScale + live 3D Placement Preview) ── */
  const pushTranslationToSession = useCallback(
    (nextTranslation: readonly [number, number, number]) => {
      if (!editIdentity || baseline.mode !== "committed") return;
      objectEditSession.updateDraft(editIdentity, (current) =>
        ([0, 1, 2] as const).reduce(
          (next, axis) =>
            updateQuantityFieldSI(next, `translation.${axis}`, nextTranslation[axis]),
          current,
        ),
      );
      lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;
    },
    [baseline.mode, editIdentity, objectEditSession],
  );

  const handleFieldChange = useCallback(
    <K extends keyof ObjectGeometrySpecDraft & string>(
      key: K,
      value: ObjectGeometrySpecDraft[K],
    ) => {
      if (key === "scale") {
        const nextScale = applyUniformScaleChange(
          controller.draft.scale,
          value as readonly [number, number, number],
          controller.draft.uniformScale,
        );
        controller.setField("scale", nextScale);
        return;
      }
      if (key === "uniformScale") {
        const enabled = Boolean(value);
        if (enabled) {
          const normalized = normalizeScaleForUniformLock(controller.draft.scale);
          controller.patchDraft({
            uniformScale: true,
            ...(vec3ApproxEqual(normalized, controller.draft.scale)
              ? {}
              : { scale: normalized }),
          });
        } else {
          controller.setField("uniformScale", false);
        }
        return;
      }
      if (key === "translation") {
        const nextVec = value as readonly [number, number, number];
        controller.setField("translation", nextVec);
        pushTranslationToSession(nextVec);
        return;
      }
      controller.setField(key, value);
    },
    [controller, pushTranslationToSession],
  );

  const handlePatchDraft = useCallback(
    (partial: Partial<ObjectGeometrySpecDraft>) => {
      controller.patchDraft(partial);
      if (partial.translation) {
        pushTranslationToSession(partial.translation);
      }
    },
    [controller, pushTranslationToSession],
  );

  const handleRevertField = useCallback(
    (fieldKey: string) => {
      controller.revertField(fieldKey);
      if (fieldKey === "translation") {
        pushTranslationToSession(controller.baseline.translation);
      }
    },
    [controller, pushTranslationToSession],
  );

  const handleRevertAll = useCallback(() => {
    if (
      placementGestureActive ||
      (sceneWritePending && !ownObjectApplyPending && !ownCreatePending)
    ) {
      return;
    }
    controller.revertAll();
  }, [
    controller,
    ownCreatePending,
    ownObjectApplyPending,
    placementGestureActive,
    sceneWritePending,
  ]);

  /* ── Standard Chrome Callbacks & Code Preview Dialog ── */
  const [codePreview, setCodePreview] = useState<{
    title: string;
    language: "python" | "json";
    code: string;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel.selection.set(next, "inspector");
    },
    [kernel.selection],
  );

  const handleFitView = useCallback(
    (commandId?: Parameters<typeof kernel.commands.execute>[0]) => {
      const resolvedId = commandId ?? "viewport-3d.fit-selection";
      void kernel.commands.execute(resolvedId, createCommandContext("inspector", kernel));
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    kernel.layout.setPanelVisible("right", false);
  }, [kernel.layout]);

  const handleOpenCodePreview = useCallback(
    (title: string, language: "python" | "json", code: string) => {
      setCopiedCode(false);
      setCodePreview({ title, language, code });
    },
    [],
  );

  const handleNotify = useCallback((title: string, description?: string) => {
    setStatusToast(description ? `${title}: ${description}` : title);
  }, []);

  const codeLanguageLabel = useMemo(
    () => (codePreview?.language === "json" ? "JSON payload" : "Python authoring snippet"),
    [codePreview?.language],
  );

  return (
    <>
      {controller.draft.mode === "draft-new" ? (
        <LiveDraftOverlayPublisher
          baseline={controller.baseline}
          draft={controller.draft}
          invalidFields={controller.invalidFields}
        />
      ) : null}

      <InspectorTemplate
        activeModeTabId={controller.activeModeTabId}
        animationKey={controller.animationKey}
        appliedFlash={controller.appliedFlash}
        applyError={controller.applyError}
        applying={controller.applying}
        baseline={controller.baseline}
        dirtyFields={controller.dirtyFields}
        displayUnits={controller.displayUnits}
        draft={controller.draft}
        forceShowErrors={controller.forceShowErrors}
        invalidFields={controller.invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={controller.touchedFields}
        onActiveModeTabChange={controller.setActiveModeTabId}
        onApply={controller.requestApply}
        onDisplayUnitChange={controller.setDisplayUnit}
        onFieldChange={handleFieldChange}
        onFieldTouch={controller.touchField}
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof ObjectGeometrySpecDraft & string)}
        onHideInspector={handleHideInspector}
        onNotify={handleNotify}
        onOpenCodePreview={handleOpenCodePreview}
        onParseErrorChange={controller.setParseError}
        onPatchDraft={handlePatchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={handleRevertAll}
        onRevertField={handleRevertField}
        onSelectNode={handleSelectNode}
      />

      {statusToast ? (
        <span className="sr-only" role="status">
          {statusToast}
        </span>
      ) : null}

      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{codePreview?.title ?? "Code preview"}</DialogTitle>
            <DialogDescription>{codeLanguageLabel}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-3 font-mono text-xs text-[var(--fm-text)]">
            <code>{codePreview?.code ?? ""}</code>
          </pre>
          <DialogFooter>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                if (codePreview) {
                  void navigator.clipboard?.writeText(codePreview.code).catch(() => undefined);
                  setCopiedCode(true);
                }
              }}
            >
              {copiedCode ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
              <span>{copiedCode ? "Copied" : "Copy"}</span>
            </Button>
            <Button
              size="sm"
              type="button"
              variant="primary"
              onClick={() => setCodePreview(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function GeometryObjectInspectorPanel(props: InspectorPanelProps) {
  return <SharedGeometrySpecPanel {...props} forceBuilderMode={false} />;
}

export function BuilderPrimitiveInspectorPanel(props: InspectorPanelProps) {
  return <SharedGeometrySpecPanel {...props} forceBuilderMode={true} />;
}
