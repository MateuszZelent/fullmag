import type { JsonObject } from "@/kernel/api/apiTypes";
import { parseArray3DGeometry } from "@/kernel/authoring/array3dModel";
import { parseCompositeGeometry } from "@/modules/explorer/builders/geometryTreeExplorerNodes";

import {
  eulerDegToQuat,
  formatLengthAuto,
  formatSpanAuto,
  quatToEulerDeg,
} from "../../../panels/model-roots/SpecInspectorHost";

import {
  axisVectorFromSymmetryAxis,
  normalizeZero,
  parseSymmetryAxis,
  vec3ApproxEqual,
  type Array3DDraftConfig,
  type InlineOperandEditPatch,
} from "./geometryShared";

export type EditableNodePrimitiveKind =
  | "Box"
  | "Cylinder"
  | "Sphere"
  | "Ellipsoid"
  | "Cone"
  | "Torus";

export const EDITABLE_NODE_PRIMITIVE_KINDS: ReadonlySet<string> = new Set<EditableNodePrimitiveKind>([
  "Box",
  "Cylinder",
  "Sphere",
  "Ellipsoid",
  "Cone",
  "Torus",
]);

export type GeometryNodeContainerKind =
  | "boolean-operand"
  | "legacy-pair"
  | "array-child"
  | "slice-child";

export interface GeometryNodeAncestor {
  readonly label: string;
  readonly path: string;
}

export interface ResolvedGeometryTreeNode {
  readonly path: string;
  readonly segments: readonly string[];
  readonly depth: number;
  readonly segmentId: string;
  readonly containerKind: GeometryNodeContainerKind;
  readonly label: string;
  readonly roleBadge: string;
  readonly enabled: boolean;
  readonly canEditOperandMeta: boolean;
  readonly isTopLevelBooleanOperand: boolean;
  readonly index: number;
  readonly total: number;
  readonly rawGeometry: Record<string, unknown>;
  readonly geometry: Record<string, unknown>;
  readonly geometryKind: string;
  readonly isEditablePrimitive: boolean;
  readonly transform: Record<string, unknown> | null;
  readonly isArray3D: boolean;
  readonly arrayUnitSummary: string | null;
  readonly arrayChildPath: string | null;
  readonly ancestors: readonly GeometryNodeAncestor[];
}

export interface GeometryNodePatch {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly symmetryAxis?: "x" | "y" | "z";
  readonly sizeX?: number;
  readonly sizeY?: number;
  readonly sizeZ?: number;
  readonly radius?: number;
  readonly height?: number;
  readonly bottomRadius?: number;
  readonly topRadius?: number;
  readonly majorRadius?: number;
  readonly minorRadius?: number;
  readonly translation?: readonly [number, number, number];
  readonly eulerDeg?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
  readonly array3dConfig?: Array3DDraftConfig | null;
}

export interface ExtractedTransformVectors {
  readonly translation: readonly [number, number, number];
  readonly eulerDeg: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

const LEGACY_CSG_PAIRS: readonly (readonly [string, string])[] = [
  ["base", "tool"],
  ["a", "b"],
  ["left", "right"],
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function geometryKindOf(geometry: Record<string, unknown>): string {
  return asString(geometry.geometry_kind) ?? asString(geometry.kind) ?? "Box";
}

function geometryParamsKeyOf(geometry: Record<string, unknown>): "geometry_params" | "params" {
  if (asRecord(geometry.geometry_params)) return "geometry_params";
  if (asRecord(geometry.params)) return "params";
  return "geometry_params";
}

function geometryParamsOf(geometry: Record<string, unknown>): Record<string, unknown> {
  return asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};
}

function isTransformWrapperKind(kind: string): boolean {
  const lower = kind.trim().toLowerCase();
  return lower === "translate" || lower === "transform";
}

function isTransformWrapper(geometry: Record<string, unknown>): boolean {
  return isTransformWrapperKind(geometryKindOf(geometry));
}

function wrapperChildKey(params: Record<string, unknown>): "child" | "base" | null {
  if (asRecord(params.child)) return "child";
  if (asRecord(params.base)) return "base";
  return null;
}

export function unwrapTransformWrappers(
  geometry: Record<string, unknown>,
): Record<string, unknown> {
  let current = geometry;
  for (let i = 0; i < 8; i += 1) {
    if (!isTransformWrapper(current)) break;
    const params = geometryParamsOf(current);
    const key = wrapperChildKey(params);
    if (!key) break;
    const child = asRecord(params[key]);
    if (!child) break;
    current = child;
  }
  return current;
}

function extractWrapperTransform(
  geometry: Record<string, unknown>,
): Record<string, unknown> | null {
  const kind = geometryKindOf(geometry).trim().toLowerCase();
  const params = geometryParamsOf(geometry);
  if (kind === "translate") {
    const offset = Array.isArray(params.offset)
      ? params.offset
      : Array.isArray(params.by)
        ? params.by
        : null;
    if (!offset) return null;
    return {
      translation: [numberOr(offset[0], 0), numberOr(offset[1], 0), numberOr(offset[2], 0)],
    };
  }
  if (kind === "transform") {
    const nested = asRecord(params.transform);
    if (nested) return nested;
    const out: Record<string, unknown> = {};
    if (Array.isArray(params.translation)) out.translation = params.translation;
    if (Array.isArray(params.rotation_quat)) out.rotation_quat = params.rotation_quat;
    if (Array.isArray(params.scale)) out.scale = params.scale;
    if (Array.isArray(params.pivot)) out.pivot = params.pivot;
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

export function extractTransformVectors(
  transform: Record<string, unknown> | null,
): ExtractedTransformVectors {
  const tr = Array.isArray(transform?.translation) ? transform.translation : [0, 0, 0];
  const sc = Array.isArray(transform?.scale) ? transform.scale : [1, 1, 1];
  const quat = Array.isArray(transform?.rotation_quat)
    ? (transform.rotation_quat as number[])
    : [0, 0, 0, 1];
  return {
    translation: [numberOr(tr[0], 0), numberOr(tr[1], 0), numberOr(tr[2], 0)],
    eulerDeg: quatToEulerDeg(quat),
    scale: [numberOr(sc[0], 1), numberOr(sc[1], 1), numberOr(sc[2], 1)],
  };
}

export function normalizeEditablePrimitiveKind(rawKind: string): EditableNodePrimitiveKind | null {
  const clean = rawKind.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (clean) {
    case "box":
      return "Box";
    case "cylinder":
    case "disk":
      return "Cylinder";
    case "sphere":
      return "Sphere";
    case "ellipsoid":
      return "Ellipsoid";
    case "cone":
    case "frustum":
      return "Cone";
    case "torus":
      return "Torus";
    default:
      return null;
  }
}

export function parseGeometryNodePath(nodePath: string): string[] {
  return nodePath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function formatGeometryUnitSummary(geometry: unknown): string | null {
  const rec = asRecord(geometry);
  if (!rec) return null;
  const unwrapped = unwrapTransformWrappers(rec);
  const kind = geometryKindOf(unwrapped);
  const params = geometryParamsOf(unwrapped);
  const editable = normalizeEditablePrimitiveKind(kind);

  if (editable === "Cylinder") {
    const r = formatLengthAuto(numberOr(params.radius, 25e-9)) ?? "25 nm";
    const h = formatLengthAuto(numberOr(params.height ?? params.length, 20e-9)) ?? "20 nm";
    return `Cylinder (r = ${r}, h = ${h})`;
  }
  if (editable === "Box") {
    const size = Array.isArray(params.size) ? params.size : [100e-9, 100e-9, 10e-9];
    const span =
      formatSpanAuto([
        numberOr(size[0], 100e-9),
        numberOr(size[1], 100e-9),
        numberOr(size[2], 10e-9),
      ]) ?? "100 × 100 × 10 nm";
    return `Box (${span})`;
  }
  if (editable === "Sphere") {
    const r = formatLengthAuto(numberOr(params.radius, 25e-9)) ?? "25 nm";
    return `Sphere (r = ${r})`;
  }
  if (editable === "Ellipsoid") {
    const size = Array.isArray(params.size) ? params.size : null;
    const radii = Array.isArray(params.radii) ? params.radii : null;
    const sx = size ? numberOr(size[0], 100e-9) : radii ? numberOr(radii[0], 50e-9) * 2 : 100e-9;
    const sy = size ? numberOr(size[1], 100e-9) : radii ? numberOr(radii[1], 50e-9) * 2 : 100e-9;
    const sz = size ? numberOr(size[2], 10e-9) : radii ? numberOr(radii[2], 5e-9) * 2 : 10e-9;
    const span = formatSpanAuto([sx, sy, sz]) ?? "100 × 100 × 10 nm";
    return `Ellipsoid (${span})`;
  }
  if (editable === "Cone") {
    const rBot =
      formatLengthAuto(numberOr(params.radius_bottom ?? params.bottom_radius, 50e-9)) ?? "50 nm";
    const rTop =
      formatLengthAuto(numberOr(params.radius_top ?? params.top_radius, 25e-9)) ?? "25 nm";
    const h = formatLengthAuto(numberOr(params.height, 20e-9)) ?? "20 nm";
    return `Cone (r₁ = ${rBot}, r₂ = ${rTop}, h = ${h})`;
  }
  if (editable === "Torus") {
    const rMaj = formatLengthAuto(numberOr(params.major_radius, 80e-9)) ?? "80 nm";
    const rMin = formatLengthAuto(numberOr(params.minor_radius, 20e-9)) ?? "20 nm";
    return `Torus (R = ${rMaj}, r = ${rMin})`;
  }

  const parsedComposite = parseCompositeGeometry(unwrapped);
  if (parsedComposite.op && parsedComposite.operands.length > 0) {
    return `${kind} (${parsedComposite.operands.length} ${parsedComposite.operands.length === 1 ? "child" : "children"})`;
  }
  return kind;
}

function resolveArrayChildDisplayLabel(
  operandLabel: string,
  childGeometry: Record<string, unknown>,
  parentLabel?: string,
): string {
  const childKind = geometryKindOf(unwrapTransformWrappers(childGeometry));
  if (parentLabel && parentLabel.trim().length > 0) {
    const cleanParent = parentLabel.trim();
    const lowerParent = cleanParent.toLowerCase();
    const lowerKind = childKind.toLowerCase();
    if (lowerParent === lowerKind || lowerParent.includes(`(${lowerKind})`)) {
      return `${childKind} (Unit)`;
    }
    return `${cleanParent} (${childKind})`;
  }
  return operandLabel;
}

function detectContainerKind(
  containerGeometry: Record<string, unknown>,
  parsedOp: ReturnType<typeof parseCompositeGeometry>["op"],
): GeometryNodeContainerKind {
  if (parsedOp === "array") return "array-child";
  if (parsedOp === "slice") return "slice-child";
  const unwrapped = unwrapTransformWrappers(containerGeometry);
  const params = geometryParamsOf(unwrapped);
  if (Array.isArray(params.operands)) return "boolean-operand";
  return "legacy-pair";
}

export function resolveGeometryNodeByPath(
  rootGeometry: unknown,
  nodePath: string,
): ResolvedGeometryTreeNode | null {
  const rootRecord = asRecord(rootGeometry);
  if (!rootRecord) return null;
  const segments = parseGeometryNodePath(nodePath);
  if (segments.length === 0) return null;

  let currentContainer: Record<string, unknown> = rootRecord;
  let parentLabel: string | undefined;
  const ancestors: GeometryNodeAncestor[] = [];
  const walkedSegments: string[] = [];

  for (let depth = 0; depth < segments.length; depth += 1) {
    const segment = segments[depth]!;
    const parsed = parseCompositeGeometry(currentContainer);
    const operand = parsed.operands.find((entry) => entry.operandId === segment);
    if (!operand) return null;

    walkedSegments.push(segment);
    const walkedPath = walkedSegments.join("/");
    const containerKind = detectContainerKind(currentContainer, parsed.op);
    const resolvedLabel =
      parsed.op === "array"
        ? resolveArrayChildDisplayLabel(operand.label, operand.geometry, parentLabel)
        : operand.label;

    if (depth < segments.length - 1) {
      ancestors.push({ label: resolvedLabel, path: walkedPath });
      parentLabel = resolvedLabel;
      currentContainer = operand.geometry;
      continue;
    }

    const rawGeometry = operand.geometry;
    const unwrappedGeometry = unwrapTransformWrappers(rawGeometry);
    const geometryKind = geometryKindOf(unwrappedGeometry);
    const parsedArray = parseArray3DGeometry(unwrappedGeometry);
    const effectiveTransform =
      asRecord(operand.transform) ?? extractWrapperTransform(rawGeometry);
    const editableKind = normalizeEditablePrimitiveKind(geometryKind);

    return {
      path: walkedPath,
      segments: walkedSegments,
      depth,
      segmentId: segment,
      containerKind,
      label: resolvedLabel,
      roleBadge: operand.roleBadge,
      enabled: operand.enabled,
      canEditOperandMeta: containerKind === "boolean-operand",
      isTopLevelBooleanOperand: depth === 0 && containerKind === "boolean-operand",
      index: operand.index,
      total: operand.total,
      rawGeometry,
      geometry: unwrappedGeometry,
      geometryKind: editableKind ?? geometryKind,
      isEditablePrimitive: editableKind !== null,
      transform: effectiveTransform,
      isArray3D: parsedArray !== null,
      arrayUnitSummary: parsedArray ? formatGeometryUnitSummary(parsedArray.child) : null,
      arrayChildPath: parsedArray ? `${walkedPath}/array-child` : null,
      ancestors,
    };
  }

  return null;
}

function isIdentityTranslation(vec: readonly [number, number, number]): boolean {
  return Math.abs(vec[0]) <= 1e-15 && Math.abs(vec[1]) <= 1e-15 && Math.abs(vec[2]) <= 1e-15;
}

function isIdentityEuler(vec: readonly [number, number, number]): boolean {
  return Math.abs(vec[0]) <= 1e-5 && Math.abs(vec[1]) <= 1e-5 && Math.abs(vec[2]) <= 1e-5;
}

function isIdentityScale(vec: readonly [number, number, number]): boolean {
  return (
    Math.abs(vec[0] - 1) <= 1e-9 &&
    Math.abs(vec[1] - 1) <= 1e-9 &&
    Math.abs(vec[2] - 1) <= 1e-9
  );
}

function mergeNodeTransform(
  existing: Record<string, unknown> | null,
  patch: GeometryNodePatch,
): Record<string, unknown> | null {
  const existingVecs = extractTransformVectors(existing);
  const translationChanged =
    patch.translation !== undefined &&
    !vec3ApproxEqual(patch.translation, existingVecs.translation, 1e-15);
  const eulerChanged =
    patch.eulerDeg !== undefined &&
    !vec3ApproxEqual(patch.eulerDeg, existingVecs.eulerDeg, 1e-5);
  const scaleChanged =
    patch.scale !== undefined && !vec3ApproxEqual(patch.scale, existingVecs.scale, 1e-9);

  if (!existing && !translationChanged && !eulerChanged && !scaleChanged) {
    return null;
  }

  const next: Record<string, unknown> = existing ? { ...existing } : {};
  if (translationChanged && patch.translation) {
    next.translation = [
      normalizeZero(patch.translation[0]),
      normalizeZero(patch.translation[1]),
      normalizeZero(patch.translation[2]),
    ];
  }
  if (eulerChanged && patch.eulerDeg) {
    next.rotation_quat = eulerDegToQuat(patch.eulerDeg);
  }
  if (scaleChanged && patch.scale) {
    next.scale = [patch.scale[0], patch.scale[1], patch.scale[2]];
  }
  return next;
}

export function applyArray3DConfigToGeometry(
  rawGeom: Record<string, unknown>,
  array3dConfig: Array3DDraftConfig | null | undefined,
): Record<string, unknown> {
  if (array3dConfig === undefined) return rawGeom;

  if (isTransformWrapper(rawGeom)) {
    const paramsKey = geometryParamsKeyOf(rawGeom);
    const params = geometryParamsOf(rawGeom);
    const childKey = wrapperChildKey(params);
    if (!childKey) return rawGeom;
    const child = asRecord(params[childKey]);
    if (!child) return rawGeom;
    return {
      ...rawGeom,
      [paramsKey]: {
        ...params,
        [childKey]: applyArray3DConfigToGeometry(child, array3dConfig),
      },
    };
  }

  const kind = geometryKindOf(rawGeom).trim().toLowerCase();
  const isArray = kind === "array3d" || kind === "array_3d";

  if (array3dConfig === null) {
    if (!isArray) return rawGeom;
    const params = geometryParamsOf(rawGeom);
    const childKey = wrapperChildKey(params);
    const child = childKey ? asRecord(params[childKey]) : null;
    return child ?? rawGeom;
  }

  if (isArray) {
    const paramsKey = geometryParamsKeyOf(rawGeom);
    const params = geometryParamsOf(rawGeom);
    return {
      ...rawGeom,
      [paramsKey]: {
        ...params,
        axes: array3dConfig.axes,
        merge_overlapping: array3dConfig.mergeOverlapping,
      },
    };
  }

  return {
    geometry_kind: "Array3D",
    geometry_params: {
      axes: array3dConfig.axes,
      child: rawGeom,
      merge_overlapping: array3dConfig.mergeOverlapping,
    },
  };
}

function patchPrimitiveGeometry(
  rawGeom: Record<string, unknown>,
  patch: GeometryNodePatch,
): Record<string, unknown> {
  if (isTransformWrapper(rawGeom)) {
    const paramsKey = geometryParamsKeyOf(rawGeom);
    const params = geometryParamsOf(rawGeom);
    const childKey = wrapperChildKey(params);
    if (!childKey) return rawGeom;
    const child = asRecord(params[childKey]);
    if (!child) return rawGeom;
    return {
      ...rawGeom,
      [paramsKey]: {
        ...params,
        [childKey]: patchPrimitiveGeometry(child, patch),
      },
    };
  }

  const editableKind = normalizeEditablePrimitiveKind(geometryKindOf(rawGeom));
  if (!editableKind) {
    return applyArray3DConfigToGeometry(rawGeom, patch.array3dConfig);
  }

  const paramsKey = geometryParamsKeyOf(rawGeom);
  const prevParams = geometryParamsOf(rawGeom);
  const nextParams: Record<string, unknown> = { ...prevParams };

  switch (editableKind) {
    case "Box":
      if (
        patch.sizeX !== undefined &&
        patch.sizeY !== undefined &&
        patch.sizeZ !== undefined
      ) {
        nextParams.size = [patch.sizeX, patch.sizeY, patch.sizeZ];
      }
      break;
    case "Ellipsoid":
      if (
        patch.sizeX !== undefined &&
        patch.sizeY !== undefined &&
        patch.sizeZ !== undefined
      ) {
        nextParams.radii = [patch.sizeX / 2, patch.sizeY / 2, patch.sizeZ / 2];
        nextParams.size = [patch.sizeX, patch.sizeY, patch.sizeZ];
      }
      break;
    case "Cylinder":
      if (patch.radius !== undefined) nextParams.radius = patch.radius;
      if (patch.height !== undefined) nextParams.height = patch.height;
      if (
        patch.symmetryAxis !== undefined &&
        (prevParams.axis !== undefined ||
          patch.symmetryAxis !== parseSymmetryAxis(prevParams.axis))
      ) {
        nextParams.axis = axisVectorFromSymmetryAxis(patch.symmetryAxis);
      }
      break;
    case "Sphere":
      if (patch.radius !== undefined) nextParams.radius = patch.radius;
      break;
    case "Cone":
      if (patch.bottomRadius !== undefined) {
        delete nextParams.bottom_radius;
        nextParams.radius_bottom = patch.bottomRadius;
      }
      if (patch.topRadius !== undefined) {
        delete nextParams.top_radius;
        nextParams.radius_top = patch.topRadius;
      }
      if (patch.height !== undefined) nextParams.height = patch.height;
      if (
        patch.symmetryAxis !== undefined &&
        (prevParams.axis !== undefined ||
          patch.symmetryAxis !== parseSymmetryAxis(prevParams.axis))
      ) {
        nextParams.axis = axisVectorFromSymmetryAxis(patch.symmetryAxis);
      }
      break;
    case "Torus":
      if (patch.majorRadius !== undefined) nextParams.major_radius = patch.majorRadius;
      if (patch.minorRadius !== undefined) nextParams.minor_radius = patch.minorRadius;
      if (
        patch.symmetryAxis !== undefined &&
        (prevParams.axis !== undefined ||
          patch.symmetryAxis !== parseSymmetryAxis(prevParams.axis))
      ) {
        nextParams.axis = axisVectorFromSymmetryAxis(patch.symmetryAxis);
      }
      break;
  }

  const patchedPrimitive: Record<string, unknown> = {
    ...rawGeom,
    [paramsKey]: nextParams,
  };
  return applyArray3DConfigToGeometry(patchedPrimitive, patch.array3dConfig);
}

function patchWrappedGeometryAndTransform(
  rawGeom: Record<string, unknown>,
  patch: GeometryNodePatch,
): Record<string, unknown> {
  const existingTx = extractWrapperTransform(rawGeom);
  const unwrapped = unwrapTransformWrappers(rawGeom);
  const patchedInner = patchPrimitiveGeometry(unwrapped, patch);
  const mergedTx = mergeNodeTransform(existingTx, patch);
  if (!mergedTx) {
    return isTransformWrapper(rawGeom) ? patchPrimitiveGeometry(rawGeom, patch) : patchedInner;
  }

  const nextVecs = extractTransformVectors(mergedTx);
  const hasRotation = !isIdentityEuler(nextVecs.eulerDeg);
  const hasScale = !isIdentityScale(nextVecs.scale);
  const hasTranslation = !isIdentityTranslation(nextVecs.translation);
  const hasExtraKeys = Object.keys(mergedTx).some(
    (key) => key !== "translation" && key !== "rotation_quat" && key !== "scale",
  );

  if (!hasTranslation && !hasRotation && !hasScale && !hasExtraKeys) {
    return patchedInner;
  }

  if (!hasRotation && !hasScale && !hasExtraKeys) {
    return {
      geometry_kind: "Translate",
      geometry_params: {
        child: patchedInner,
        offset: [nextVecs.translation[0], nextVecs.translation[1], nextVecs.translation[2]],
      },
    };
  }

  return {
    geometry_kind: "Transform",
    geometry_params: {
      child: patchedInner,
      transform: mergedTx,
    },
  };
}

function patchAtSegments(
  node: Record<string, unknown>,
  segments: readonly string[],
  patch: GeometryNodePatch,
): Record<string, unknown> | null {
  if (segments.length === 0) return null;

  if (isTransformWrapper(node)) {
    const paramsKey = geometryParamsKeyOf(node);
    const params = geometryParamsOf(node);
    const childKey = wrapperChildKey(params);
    if (!childKey) return null;
    const child = asRecord(params[childKey]);
    if (!child) return null;
    const nextChild = patchAtSegments(child, segments, patch);
    if (!nextChild) return null;
    return {
      ...node,
      [paramsKey]: {
        ...params,
        [childKey]: nextChild,
      },
    };
  }

  const [head, ...rest] = segments;
  const isTarget = rest.length === 0;
  const kind = geometryKindOf(node).trim().toLowerCase();
  const paramsKey = geometryParamsKeyOf(node);
  const params = geometryParamsOf(node);

  // Array3D: descend through `child` (and patch `child_transform` at target)
  if (kind === "array3d" || kind === "array_3d") {
    if (head !== "array-child") return null;
    const childKey = wrapperChildKey(params);
    if (!childKey) return null;
    const childGeom = asRecord(params[childKey]);
    if (!childGeom) return null;

    if (!isTarget) {
      const nextChild = patchAtSegments(childGeom, rest, patch);
      if (!nextChild) return null;
      return {
        ...node,
        [paramsKey]: {
          ...params,
          [childKey]: nextChild,
        },
      };
    }

    const existingChildTx = asRecord(params.child_transform);
    if (!existingChildTx && isTransformWrapper(childGeom)) {
      const nextChild = patchWrappedGeometryAndTransform(childGeom, patch);
      return {
        ...node,
        [paramsKey]: {
          ...params,
          [childKey]: nextChild,
        },
      };
    }

    const nextChild = patchPrimitiveGeometry(childGeom, patch);
    const nextChildTx = mergeNodeTransform(existingChildTx, patch);
    const nextParams: Record<string, unknown> = {
      ...params,
      [childKey]: nextChild,
      ...(nextChildTx !== null ? { child_transform: nextChildTx } : {}),
    };
    return {
      ...node,
      [paramsKey]: nextParams,
    };
  }

  // SlicePlane: descend through `child`
  if (kind === "sliceplane" || kind === "slice_plane") {
    if (head !== "slice-child") return null;
    const childKey = wrapperChildKey(params);
    if (!childKey) return null;
    const childGeom = asRecord(params[childKey]);
    if (!childGeom) return null;

    const nextChild = isTarget
      ? patchWrappedGeometryAndTransform(childGeom, patch)
      : patchAtSegments(childGeom, rest, patch);
    if (!nextChild) return null;

    return {
      ...node,
      [paramsKey]: {
        ...params,
        [childKey]: nextChild,
      },
    };
  }

  // Canonical Boolean `operands[]`
  if (Array.isArray(params.operands)) {
    const matchIndex = params.operands.findIndex((entry, idx) => {
      const rec = asRecord(entry);
      if (!rec) return false;
      const id = asString(rec.operand_id) ?? `operand-${idx}`;
      return id === head;
    });
    if (matchIndex === -1) return null;

    const targetEntry = asRecord(params.operands[matchIndex]);
    if (!targetEntry) return null;
    const childGeom = asRecord(targetEntry.geometry) ?? targetEntry;

    let updatedEntry: Record<string, unknown>;
    if (!isTarget) {
      const nextChild = patchAtSegments(childGeom, rest, patch);
      if (!nextChild) return null;
      updatedEntry = asRecord(targetEntry.geometry)
        ? { ...targetEntry, geometry: nextChild }
        : nextChild;
    } else {
      const existingTx = asRecord(targetEntry.transform);
      const nextGeom =
        !existingTx && isTransformWrapper(childGeom)
          ? patchWrappedGeometryAndTransform(childGeom, patch)
          : patchPrimitiveGeometry(childGeom, patch);
      const nextTx =
        !existingTx && isTransformWrapper(childGeom)
          ? null
          : mergeNodeTransform(existingTx, patch);
      updatedEntry = {
        ...targetEntry,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.label !== undefined && patch.label.trim().length > 0
          ? { label: patch.label.trim() }
          : {}),
        geometry: nextGeom,
        ...(nextTx !== null ? { transform: nextTx } : {}),
      };
    }

    const nextOperands = params.operands.map((entry, idx) =>
      idx === matchIndex ? updatedEntry : entry,
    );
    return {
      ...node,
      [paramsKey]: {
        ...params,
        operands: nextOperands,
      },
    };
  }

  // Legacy 2-operand CSG pairs: { base, tool }, { a, b }, { left, right }
  for (const [firstKey, secondKey] of LEGACY_CSG_PAIRS) {
    const first = asRecord(params[firstKey]);
    const second = asRecord(params[secondKey]);
    if (!first || !second) continue;
    if (head !== firstKey && head !== secondKey) return null;
    const targetRaw = head === firstKey ? first : second;
    const nextTarget = isTarget
      ? patchWrappedGeometryAndTransform(targetRaw, patch)
      : patchAtSegments(targetRaw, rest, patch);
    if (!nextTarget) return null;
    return {
      ...node,
      [paramsKey]: {
        ...params,
        [head]: nextTarget,
      },
    };
  }

  return null;
}

export function patchGeometryNodeAtPath(
  rootGeometry: unknown,
  nodePath: string,
  patch: GeometryNodePatch,
): JsonObject | null {
  const rootRecord = asRecord(rootGeometry);
  if (!rootRecord) return null;
  const segments = parseGeometryNodePath(nodePath);
  if (segments.length === 0) return null;
  const updated = patchAtSegments(rootRecord, segments, patch);
  return updated ? (updated as JsonObject) : null;
}

/**
 * Apply a map of staged inline node patches (keyed by node path) to a composite
 * geometry tree, deepest paths first so child edits survive parent Array3D updates.
 */
export function applyInlineNodePatchesToGeometry(
  rootGeometry: JsonObject,
  patches: Readonly<Record<string, InlineOperandEditPatch>>,
): JsonObject {
  const entries = Object.entries(patches).filter(([, patch]) => Object.keys(patch).length > 0);
  if (entries.length === 0) return rootGeometry;
  entries.sort(
    ([pathA], [pathB]) =>
      parseGeometryNodePath(pathB).length - parseGeometryNodePath(pathA).length,
  );
  let current: JsonObject = rootGeometry;
  for (const [nodePath, patch] of entries) {
    const next = patchGeometryNodeAtPath(current, nodePath, patch);
    if (next) {
      current = next;
    }
  }
  return current;
}
