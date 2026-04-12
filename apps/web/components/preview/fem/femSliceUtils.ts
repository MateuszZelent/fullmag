import type { FemMeshPart, MeshEntityViewStateMap } from "../../../lib/session/types";
import { defaultMeshEntityViewState } from "../../../lib/session/types";
import type { FemMeshData, FemVectorDomainFilter } from "./femMeshTypes";
import type { ObjectViewMode, SlicePlane } from "../../runs/control-room/shared";

export interface SliceVisibilityState {
  visibleElements: Uint8Array | null;
  visibleBoundaryFaces: Uint8Array | null;
  elementPartIds: (string | null)[];
  boundaryFacePartIds: (string | null)[];
  partById: Map<string, FemMeshPart>;
  visiblePartIds: Set<string>;
}

export interface SmartColorScale {
  min: number;
  max: number;
  mode: "diverging" | "positive" | "negative";
}

export function planeToClipAxis(plane: SlicePlane): "x" | "y" | "z" {
  switch (plane) {
    case "xy":
      return "z";
    case "xz":
      return "y";
    case "yz":
      return "x";
  }
}

export function clipAxisToPlane(axis: "x" | "y" | "z"): SlicePlane {
  switch (axis) {
    case "x":
      return "yz";
    case "y":
      return "xz";
    case "z":
      return "xy";
  }
}

export function normalizedClipToWorld(min: number, max: number, clipPos: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) <= 1e-18) {
    return min;
  }
  const t = Math.max(0, Math.min(1, clipPos / 100));
  return min + (max - min) * t;
}

export function worldToNormalizedClip(min: number, max: number, value: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) <= 1e-18) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

export function getSmartColorScale(
  dMin: number,
  dMax: number,
  quantityId: string | undefined,
  component: "x" | "y" | "z" | "magnitude",
): SmartColorScale {
  const isMagnetization = !quantityId || quantityId === "m";

  if (isMagnetization) {
    if (component === "magnitude") {
      return { min: 0, max: 1, mode: "positive" };
    }
    return { min: -1, max: 1, mode: "diverging" };
  }

  const range = dMax - dMin;
  if (range > 0 && range < Math.abs(dMax) * 1e-10) {
    const mid = (dMin + dMax) / 2;
    const halfSpan = Math.abs(mid) * 0.01 || 1e-20;
    dMin = mid - halfSpan;
    dMax = mid + halfSpan;
  }

  if (dMin < 0 && dMax > 0) {
    const bound = Math.max(Math.abs(dMin), Math.abs(dMax));
    return { min: -bound, max: bound, mode: "diverging" };
  }
  if (dMax <= 0) {
    return { min: dMin, max: dMax, mode: "negative" };
  }
  return { min: dMin, max: dMax, mode: "positive" };
}

function shouldShowPart(
  part: FemMeshPart,
  meshEntityViewState: MeshEntityViewStateMap,
  airSegmentVisible: boolean,
  objectViewMode: ObjectViewMode,
  visibleObjectIds: ReadonlySet<string>,
  vectorDomainFilter: FemVectorDomainFilter,
): boolean {
  const baseViewState = meshEntityViewState[part.id] ?? defaultMeshEntityViewState(part);
  if (!baseViewState.visible) return false;
  if (part.role === "air" && !airSegmentVisible) return false;
  if (vectorDomainFilter === "magnetic_only" && part.role === "air") return false;
  if (vectorDomainFilter === "airbox_only" && part.role !== "air") return false;
  if (
    objectViewMode === "isolate" &&
    part.role === "magnetic_object" &&
    part.object_id &&
    !visibleObjectIds.has(part.object_id)
  ) {
    return false;
  }
  if (
    objectViewMode === "isolate" &&
    part.role !== "air" &&
    part.role !== "magnetic_object"
  ) {
    return false;
  }
  return true;
}

export function buildSliceVisibilityState(args: {
  meshData: FemMeshData;
  meshParts: readonly FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  airSegmentVisible: boolean;
  objectViewMode: ObjectViewMode;
  visibleObjectIds: Iterable<string>;
  vectorDomainFilter: FemVectorDomainFilter;
}): SliceVisibilityState {
  const {
    meshData,
    meshParts,
    meshEntityViewState,
    airSegmentVisible,
    objectViewMode,
    visibleObjectIds,
    vectorDomainFilter,
  } = args;

  const partById = new Map(meshParts.map((part) => [part.id, part]));
  const visiblePartIds = new Set<string>();
  const visibleElements = meshParts.length > 0 ? new Uint8Array(meshData.nElements) : null;
  const visibleBoundaryFaces =
    meshParts.length > 0 ? new Uint8Array(Math.floor(meshData.boundaryFaces.length / 3)) : null;
  const elementPartIds = new Array<string | null>(meshData.nElements).fill(null);
  const boundaryFacePartIds = new Array<string | null>(Math.floor(meshData.boundaryFaces.length / 3)).fill(
    null,
  );
  const visibleObjectIdSet = new Set(visibleObjectIds);

  for (const part of meshParts) {
    const show = shouldShowPart(
      part,
      meshEntityViewState,
      airSegmentVisible,
      objectViewMode,
      visibleObjectIdSet,
      vectorDomainFilter,
    );
    if (show) visiblePartIds.add(part.id);

    const elementStart = Math.max(0, Math.trunc(part.element_start));
    const elementEnd = Math.min(meshData.nElements, elementStart + Math.max(0, Math.trunc(part.element_count)));
    for (let index = elementStart; index < elementEnd; index += 1) {
      elementPartIds[index] = part.id;
      if (show && visibleElements) visibleElements[index] = 1;
    }

    const faceStart = Math.max(0, Math.trunc(part.boundary_face_start));
    const faceEnd = Math.min(
      boundaryFacePartIds.length,
      faceStart + Math.max(0, Math.trunc(part.boundary_face_count)),
    );
    for (let index = faceStart; index < faceEnd; index += 1) {
      boundaryFacePartIds[index] = part.id;
      if (show && visibleBoundaryFaces) visibleBoundaryFaces[index] = 1;
    }

    for (const index of part.boundary_face_indices) {
      if (index < 0 || index >= boundaryFacePartIds.length) continue;
      boundaryFacePartIds[index] = part.id;
      if (show && visibleBoundaryFaces) visibleBoundaryFaces[index] = 1;
    }
  }

  return {
    visibleElements,
    visibleBoundaryFaces,
    elementPartIds,
    boundaryFacePartIds,
    partById,
    visiblePartIds,
  };
}
