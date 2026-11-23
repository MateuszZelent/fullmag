import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import type { PrimitiveDraft } from "@/kernel/authoring/geometryLifecycleCommands";
import { resolveDraftObjectName } from "@/kernel/authoring/uniqueObjectName";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  eulerDegToQuat,
  formatSpanAuto,
  formatVolumeAuto,
  quatToEulerDeg,
  type SceneObjectItem as SceneObject,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorTone } from "../../../template";

import {
  axisVectorFromSymmetryAxis,
  buildCompositeGeometrySummary,
  createPolygonVertexRow,
  normalizePrimitiveKind,
  normalizeZero,
  parseImportedMeshUnitScale,
  parseSymmetryAxis,
  resolveDefaultDraftBaseName,
  vec3ApproxEqual,
  type ObjectGeometrySpecDraft,
  type PolygonVertexRow,
} from "./geometryShared";

/* ── Serialization & Parsing ── */

export function serializeGeometryPayload(draft: ObjectGeometrySpecDraft): JsonObject {
  if (draft.compositeSummary && draft.preservedRawGeometry && draft.csgOperation === "none") {
    return draft.preservedRawGeometry;
  }

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
    case "Cone": {
      const { bottom_radius: _legacyBottom, top_radius: _legacyTop, ...coneBaseParams } = baseParams;
      primitiveDescriptor = {
        geometry_kind: "Cone",
        geometry_params: {
          ...coneBaseParams,
          radius_bottom: draft.bottomRadius,
          radius_top: draft.topRadius,
          height: draft.height,
          axis: axisVectorFromSymmetryAxis(draft.symmetryAxis),
        },
      };
      break;
    }
    case "Torus":
      primitiveDescriptor = {
        geometry_kind: "Torus",
        geometry_params: {
          ...baseParams,
          major_radius: draft.majorRadius,
          minor_radius: draft.minorRadius,
          axis: axisVectorFromSymmetryAxis(draft.symmetryAxis),
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
    case "PolygonExtrusion": {
      const {
        vertices: _legacyVerts,
        height: _legacyHeight,
        axis: _legacyAxis,
        ...prismBaseParams
      } = baseParams;
      primitiveDescriptor = {
        geometry_kind: "PolygonPrism",
        geometry_params: {
          ...prismBaseParams,
          vertices_xy: draft.polygonVertices.map((v) => [v.x_m, v.y_m]),
          thickness: draft.height,
        },
      };
      break;
    }
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

/**
 * Merge a partial Transform3D patch onto an existing committed transform without
 * zeroing omitted components (`translation`, `rotation_quat`, `scale`, `pivot`,
 * `euler_xyz_deg`, or backend extension keys).
 */
export function mergeTransformPatch(
  existingTransform: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): JsonObject {
  const base =
    existingTransform && typeof existingTransform === "object" && !Array.isArray(existingTransform)
      ? existingTransform
      : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as JsonObject;
}

export function serializeTransformPayload(
  draft: ObjectGeometrySpecDraft,
  existingTransform?: Record<string, unknown> | null,
  baselineDraft?: Pick<
    ObjectGeometrySpecDraft,
    "translation" | "eulerDeg" | "scale" | "pivotMode" | "pivotCustom"
  > | null,
): JsonObject {
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

  const serialized: JsonObject = {
    translation: [normalizeZero(tx), normalizeZero(ty), normalizeZero(tz)],
    rotation_quat: quat,
    scale: [draft.scale[0], draft.scale[1], draft.scale[2]],
    pivot,
    ...(draft.pivotMode !== "centroid" ? { pivot_mode: draft.pivotMode } : {}),
  };

  if (!existingTransform) {
    return serialized;
  }

  const patch: Record<string, unknown> = {};
  if (!baselineDraft || !vec3ApproxEqual(draft.translation, baselineDraft.translation)) {
    patch.translation = serialized.translation;
  }
  if (!baselineDraft || !vec3ApproxEqual(draft.eulerDeg, baselineDraft.eulerDeg, 1e-9)) {
    patch.rotation_quat = serialized.rotation_quat;
  }
  if (!baselineDraft || !vec3ApproxEqual(draft.scale, baselineDraft.scale)) {
    patch.scale = serialized.scale;
  }
  const pivotChanged =
    !baselineDraft ||
    draft.pivotMode !== baselineDraft.pivotMode ||
    (draft.pivotMode === "custom" &&
      !vec3ApproxEqual(draft.pivotCustom, baselineDraft.pivotCustom)) ||
    (draft.pivotMode === "origin" &&
      !vec3ApproxEqual(draft.translation, baselineDraft.translation));
  if (pivotChanged) {
    patch.pivot = serialized.pivot;
    if (draft.pivotMode !== "centroid") {
      patch.pivot_mode = draft.pivotMode;
    }
  }

  return mergeTransformPatch(existingTransform, patch);
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
  let cylinderDraft: PrimitiveDraft["cylinder"] | undefined;
  if (draft.primitiveKind === "Cylinder") {
    const r = positiveValue(draft.radius, lastValid?.radius, "radius", "Radius");
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    const axis = axisVectorFromSymmetryAxis(draft.symmetryAxis);
    if (r !== null && h !== null) {
      const absAxis = axis.map(Math.abs);
      dims = [
        2 * (absAxis[0]! * (h * 0.5) + r * Math.sqrt(Math.max(0, 1 - absAxis[0]! * absAxis[0]!))),
        2 * (absAxis[1]! * (h * 0.5) + r * Math.sqrt(Math.max(0, 1 - absAxis[1]! * absAxis[1]!))),
        2 * (absAxis[2]! * (h * 0.5) + r * Math.sqrt(Math.max(0, 1 - absAxis[2]! * absAxis[2]!))),
      ];
      cylinderDraft = { axis, height: h, radius: r };
    }
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
    dims =
      len !== null && wid !== null && h !== null && archH !== null
        ? [len, wid, h + archH]
        : null;
  } else if (draft.primitiveKind === "PolygonExtrusion") {
    const h = positiveValue(draft.height, lastValid?.height, "height", "Height");
    const verts =
      draft.polygonVertices.length >= 3
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
    ...(cylinderDraft ? { cylinder: cylinderDraft } : {}),
    kind,
    dimensions: dims,
    translation: tx !== null && ty !== null && tz !== null ? [tx, ty, tz] : null,
    errors,
  };
}

export function updateLastValidDraftSnapshot(
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
      compositeSummary: null,
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
      compositeSummary: null,
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

  const rawVerts = Array.isArray(params.vertices_xy)
    ? params.vertices_xy
    : Array.isArray(params.vertices)
      ? params.vertices
      : null;
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
    compositeSummary: buildCompositeGeometrySummary(geom),
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
    height:
      typeof params.height === "number"
        ? params.height
        : typeof params.thickness === "number"
          ? params.thickness
          : 10e-9,
    innerRadius: typeof params.inner_radius === "number" ? params.inner_radius : 20e-9,
    outerRadius: typeof params.outer_radius === "number" ? params.outer_radius : 50e-9,
    bottomRadius:
      typeof params.radius_bottom === "number"
        ? params.radius_bottom
        : typeof params.bottom_radius === "number"
          ? params.bottom_radius
          : 50e-9,
    topRadius:
      typeof params.radius_top === "number"
        ? params.radius_top
        : typeof params.top_radius === "number"
          ? params.top_radius
          : 25e-9,
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

export function computeDraftSummaryMetrics(draft: ObjectGeometrySpecDraft): {
  spanText: string | null;
  volumeText: string | null;
} {
  if (draft.compositeSummary) {
    const size = draft.compositeSummary.boundsMeters?.size;
    return {
      spanText: size ? formatSpanAuto([size[0], size[1], size[2]]) : null,
      volumeText: null,
    };
  }
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
        spanText: formatSpanAuto([2 * draft.outerRadius, 2 * draft.outerRadius, draft.height]),
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
