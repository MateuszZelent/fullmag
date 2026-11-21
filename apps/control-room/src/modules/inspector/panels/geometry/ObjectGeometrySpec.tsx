"use client";

import {
  Box,
  Combine,
  Compass,
  Move3d,
  Plus,
  Shapes,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import {
  primitiveDraftOverlayStore,
  type PrimitiveDraft,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  publishCommittedSceneResource,
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import { summarizeGeometryValidationMessages } from "../geometryObjectPanelModel";
import {
  ANGLE_UNITS,
  buildObjectSelection,
  buildRootSelection,
  eulerDegToQuat,
  fallbackRevision,
  formatLengthAuto,
  formatSpanAuto,
  formatVolumeAuto,
  LENGTH_UNITS,
  quatToEulerDeg,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
} from "../model-roots/SpecInspectorHost";

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

export interface PolygonVertexRow {
  readonly _rowId: string;
  readonly x_m: number;
  readonly y_m: number;
}

export interface ObjectGeometrySpecDraft {
  mode: "committed" | "draft-new" | "missing";
  objectId: string;
  draftName: string;
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
  meshUnitScale: "nm" | "um" | "mm" | "m";
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

/* ── Pure Validators (Exported for Direct Unit Testing) ── */

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

export function bakeScaleIntoDraft(
  draft: ObjectGeometrySpecDraft,
): Partial<ObjectGeometrySpecDraft> {
  const [sx, sy, sz] = draft.scale;
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
    default:
      return { scale: resetScale };
  }
}

/* ── Serialization & Parsing ── */

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
          axis: draft.symmetryAxis,
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
  const pivot: [number, number, number] =
    draft.pivotMode === "custom"
      ? [draft.pivotCustom[0], draft.pivotCustom[1], draft.pivotCustom[2]]
      : [0, 0, 0];
  return {
    translation: [draft.translation[0], draft.translation[1], draft.translation[2]],
    rotation_quat: quat,
    scale: [draft.scale[0], draft.scale[1], draft.scale[2]],
    pivot,
  };
}

function resolvePreviewOverlayDraft(draft: ObjectGeometrySpecDraft): PrimitiveDraft {
  const kind: PrimitiveDraft["kind"] =
    draft.primitiveKind === "Cylinder" ||
    draft.primitiveKind === "Tube" ||
    draft.primitiveKind === "Cone"
      ? "Cylinder"
      : draft.primitiveKind === "Sphere"
        ? "Sphere"
        : "Box";
  let dims: [number, number, number] = [draft.sizeX, draft.sizeY, draft.sizeZ];
  if (draft.primitiveKind === "Cylinder") {
    dims = [2 * draft.radius, draft.height, 2 * draft.radius];
  } else if (draft.primitiveKind === "Sphere") {
    dims = [2 * draft.radius, 2 * draft.radius, 2 * draft.radius];
  } else if (draft.primitiveKind === "Tube") {
    dims = [2 * draft.outerRadius, draft.height, 2 * draft.outerRadius];
  } else if (draft.primitiveKind === "Torus") {
    const d = 2 * (draft.majorRadius + draft.minorRadius);
    dims = [d, d, 2 * draft.minorRadius];
  } else if (draft.primitiveKind === "ArchWaveguide") {
    dims = [draft.length, draft.width, draft.height + draft.archHeight];
  }
  return {
    kind,
    dimensions: dims,
    translation: [draft.translation[0], draft.translation[1], draft.translation[2]],
    errors: {},
  };
}

function buildBaselineFromScene(
  selection: Parameters<typeof resolveMeshStatusFromObject>[0] extends never
    ? never
    : InspectorPanelProps["selection"],
  scene: SceneResource | null | undefined,
  forceBuilderMode: boolean,
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
    return {
      mode: "draft-new",
      objectId: "draft",
      draftName: selection.label?.trim() || `New ${primitiveKind}`,
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
      meshUnitScale: "nm",
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
      meshUnitScale: "nm",
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
  const eulerDeg = quatToEulerDeg(
    Array.isArray(tx.rotation_quat) ? (tx.rotation_quat as number[]) : [0, 0, 0, 1],
  );
  const hasCustomPivot = pvArr.some((v) => Math.abs(Number(v) || 0) > 1e-15);

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
  const hasRealizedOrDirtyMesh = tags.includes("mesh:ready") || tags.includes("mesh:dirty");
  const meshStatusPill = resolveMeshStatusFromObject(sceneObj);

  return {
    mode: "committed",
    objectId,
    draftName: sceneObj.name?.trim() || objectId,
    primitiveKind,
    symmetryAxis:
      params.axis === "x" || params.axis === "y" || params.axis === "z" ? params.axis : "z",
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
    meshUnitScale:
      params.unit_scale === "nm" ||
      params.unit_scale === "um" ||
      params.unit_scale === "mm" ||
      params.unit_scale === "m"
        ? params.unit_scale
        : "nm",
    translation: [
      Number(trArr[0]) || 0,
      Number(trArr[1]) || 0,
      Number(trArr[2]) || 0,
    ],
    eulerDeg,
    pivotMode: hasCustomPivot ? "custom" : "centroid",
    pivotCustom: [Number(pvArr[0]) || 0, Number(pvArr[1]) || 0, Number(pvArr[2]) || 0],
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

function resolveMeshStatusFromObject(sceneObj: SceneObject): {
  tone: InspectorTone;
  label: string;
} {
  const tags = Array.isArray(sceneObj.tags) ? sceneObj.tags : [];
  if (tags.includes("mesh:failed") || tags.includes("validation:blocked")) {
    return { tone: "err", label: "Validation blocked" };
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

/* ── Shared Geometry Spec Implementation ── */

function LiveDraftOverlayPublisher({ draft }: { draft: ObjectGeometrySpecDraft }) {
  useEffect(() => {
    if (draft.mode === "draft-new") {
      primitiveDraftOverlayStore.publish(resolvePreviewOverlayDraft(draft));
    } else {
      primitiveDraftOverlayStore.clear();
    }
    return () => {
      primitiveDraftOverlayStore.clear();
    };
  }, [draft]);
  return null;
}

function SharedGeometrySpecPanel({
  selection,
  forceBuilderMode,
}: InspectorPanelProps & { forceBuilderMode: boolean }) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const validation = useGeometryValidationResource();

  const baseline = useMemo(
    () => buildBaselineFromScene(selection, scene.data, forceBuilderMode),
    [forceBuilderMode, scene.data, selection],
  );

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

  const createDraftSlugId = useCallback((draft: ObjectGeometrySpecDraft) => {
    const slug = draft.draftName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${slug || draft.primitiveKind.toLowerCase()}-${Date.now().toString(36)}`;
  }, []);

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
              type: "custom",
              wide: true,
              showWhen: (d) => d.mode === "draft-new",
              render: (ctx) => <LiveDraftOverlayPublisher draft={ctx.draft} />,
            },
            {
              key: "draftName",
              type: "text",
              label: "New object name",
              showWhen: (d) => d.mode === "draft-new",
              validate: (val) => (val.trim().length === 0 ? "Object name is required." : null),
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

            /* PolygonExtrusion */
            {
              key: "polygonVertices",
              type: "table",
              label: "2D contour vertices (nm)",
              wide: true,
              showWhen: (d) => d.primitiveKind === "PolygonExtrusion",
              validate: (verts) => validateSimplePolygon(verts as readonly PolygonVertexRow[]),
              rowKey: (row: PolygonVertexRow) => row._rowId,
              rows: (d) => d.polygonVertices,
              onAddRow: (ctx) => {
                const last = ctx.draft.polygonVertices.at(-1);
                ctx.setField("polygonVertices", [
                  ...ctx.draft.polygonVertices,
                  createPolygonVertexRow((last?.x_m ?? 0) + 20e-9, last?.y_m ?? 0),
                ]);
              },
              columns: [
                {
                  id: "idx",
                  header: "#",
                  mono: true,
                  renderCell: (_row: PolygonVertexRow, idx: number) => String(idx + 1),
                },
                {
                  id: "x",
                  header: "x (nm)",
                  mono: true,
                  renderCell: (row: PolygonVertexRow) => Number((row.x_m * 1e9).toFixed(2)),
                },
                {
                  id: "y",
                  header: "y (nm)",
                  mono: true,
                  renderCell: (row: PolygonVertexRow) => Number((row.y_m * 1e9).toFixed(2)),
                },
              ],
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.primitiveKind === "PolygonExtrusion",
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="polygon-vertex-editor">
                  {ctx.draft.polygonVertices.map((vtx, idx) => (
                    <div key={vtx._rowId} className="flex items-center gap-1.5">
                      <span className="w-6 font-mono text-xs text-[var(--fm-text-muted)]">
                        V{idx + 1}
                      </span>
                      <Input
                        aria-label={`Vertex ${idx + 1} X (nm)`}
                        defaultValue={String(Number((vtx.x_m * 1e9).toFixed(3)))}
                        onBlur={(e) => {
                          const parsed = Number(e.currentTarget.value);
                          if (Number.isFinite(parsed)) {
                            ctx.setField(
                              "polygonVertices",
                              ctx.draft.polygonVertices.map((item) =>
                                item._rowId === vtx._rowId ? { ...item, x_m: parsed * 1e-9 } : item,
                              ),
                            );
                          }
                        }}
                      />
                      <Input
                        aria-label={`Vertex ${idx + 1} Y (nm)`}
                        defaultValue={String(Number((vtx.y_m * 1e9).toFixed(3)))}
                        onBlur={(e) => {
                          const parsed = Number(e.currentTarget.value);
                          if (Number.isFinite(parsed)) {
                            ctx.setField(
                              "polygonVertices",
                              ctx.draft.polygonVertices.map((item) =>
                                item._rowId === vtx._rowId ? { ...item, y_m: parsed * 1e-9 } : item,
                              ),
                            );
                          }
                        }}
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
              type: "segmented",
              label: "Coordinate unit scale",
              showWhen: (d) => d.primitiveKind === "ImportedMesh",
              options: [
                { value: "nm", label: "nm" },
                { value: "um", label: "\u00b5m" },
                { value: "mm", label: "mm" },
                { value: "m", label: "m" },
              ],
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
          footer: (ctx) => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => ctx.patchDraft(bakeScaleIntoDraft(ctx.draft))}
              >
                Bake Scale into Dimensions
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => ctx.setField("scale", [1, 1, 1])}
              >
                Reset Scale [1, 1, 1]
              </Button>
            </div>
          ),
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
        cleanMessage: (d) =>
          d.mode === "draft-new"
            ? "Adjust dimensions and click Apply to create the scene object"
            : "Parametric geometry matches committed SceneDocument",
        lockReason: (d) =>
          d.mode === "missing" ? "Select an existing object or start a primitive draft." : null,
        onApply: async (draft) => {
          const geometry = serializeGeometryPayload(draft);
          const transform = serializeTransformPayload(draft);

          if (draft.mode === "draft-new") {
            const newId = createDraftSlugId(draft);
            const tx = await kernel.api.model.commitTransaction({
              base_revision: scene.data?.revision ?? null,
              kind: "create_object",
              object_id: newId,
              name: draft.draftName.trim() || `New ${draft.primitiveKind}`,
              geometry,
              transform,
            });
            primitiveDraftOverlayStore.clear();
            publishCommittedSceneResource(
              kernel.resources,
              tx.committed_scene,
              tx.scene_revision,
            );
            kernel.resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, tx.scene_revision);
            kernel.resources.invalidate(MODEL_READINESS_PATH, tx.scene_revision);
            kernel.selection.set(
              buildObjectSelection(newId, "object.root", draft.draftName.trim() || newId),
              "inspector",
            );
            return true;
          }

          const updated = await kernel.api.model.patchObjectGeometry(draft.objectId, {
            base_revision: scene.data?.revision ?? null,
            geometry,
            transform,
          });
          const rev = fallbackRevision(updated.revision);
          publishCommittedSceneResource(kernel.resources, updated, rev);
          kernel.resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, rev);
          kernel.resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, rev);
          kernel.resources.invalidate(MODEL_READINESS_PATH, rev);
          kernel.resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, rev);
          kernel.resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, rev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          return true;
        },
      },
    }),
    [
      baseline.draftName,
      baseline.mode,
      baseline.objectId,
      createDraftSlugId,
      forceBuilderMode,
      kernel.api.model,
      kernel.resources,
      kernel.selection,
      otherObjects,
      scene.data?.revision,
      validationMessages,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export function GeometryObjectInspectorPanel(props: InspectorPanelProps) {
  return <SharedGeometrySpecPanel {...props} forceBuilderMode={false} />;
}

export function BuilderPrimitiveInspectorPanel(props: InspectorPanelProps) {
  return <SharedGeometrySpecPanel {...props} forceBuilderMode={true} />;
}
