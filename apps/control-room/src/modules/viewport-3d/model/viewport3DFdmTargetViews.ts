import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";
import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedFieldVector,
} from "@/kernel/api/codecs";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import type { VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type { FdmCuboidInstanceModel } from "../layers/fdmCuboidBuildModel";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";

export interface Viewport3DFdmTargetView {
  cellIndices: Uint32Array;
  instanceOrdinals: Uint32Array;
  ownerTarget: VisualizationTargetRef;
  sourceModel: FdmCuboidInstanceModel;
  surfaceInstanceOrdinals: Uint32Array;
  target: VisualizationTargetRef;
}

export interface Viewport3DFdmTargetDefinition {
  numericRegionId: number | null;
  ownerTarget: VisualizationTargetRef;
  target: VisualizationTargetRef;
}

export interface Viewport3DFdmTargetDefinitionsResult {
  definitions: readonly Viewport3DFdmTargetDefinition[];
  reason: string | null;
  status: "incompatible" | "ready";
}

export interface Viewport3DFdmTargetRenderView extends Viewport3DFdmTargetView {
  fieldVector: DecodedFieldVector | null;
  settings: VisualizationTargetSettings;
  surfaceColors: ScalarColorBuffer | null;
  vectorColors: ScalarColorBuffer | null;
  vectorGlyphColors: ScalarColorBuffer | null;
  vectorSegments: Float32Array | null;
}

export function buildViewport3DFdmTargetSurfaceCellIndices(
  view: Viewport3DFdmTargetView,
): Uint32Array {
  const cellIndices = new Uint32Array(view.surfaceInstanceOrdinals.length);
  for (let index = 0; index < view.surfaceInstanceOrdinals.length; index += 1) {
    const instanceOrdinal = view.surfaceInstanceOrdinals[index] ?? 0;
    cellIndices[index] = view.sourceModel.cellIndices[instanceOrdinal] ?? 0;
  }
  return cellIndices;
}

export interface Viewport3DFdmTargetViewsResult {
  reason: string | null;
  status: "incompatible" | "ready";
  views: readonly Viewport3DFdmTargetView[];
}

export interface Viewport3DFdmTargetRenderViewCacheEntry {
  baseView: Viewport3DFdmTargetView;
  renderKey: string;
  view: Viewport3DFdmTargetRenderView;
}

const renderViewCache = new WeakMap<
  Viewport3DFdmTargetView,
  Viewport3DFdmTargetRenderViewCacheEntry
>();

interface MutableTargetView {
  instanceOrdinals: number[];
  ownerTarget: VisualizationTargetRef;
  target: VisualizationTargetRef;
}

export function buildViewport3DFdmTargetViews({
  membership,
  model,
  realizedRegionIds,
}: {
  membership: FdmRegionMembershipResource | null | undefined;
  model: FdmCuboidInstanceModel | null | undefined;
  realizedRegionIds: Uint32Array | null | undefined;
}): Viewport3DFdmTargetViewsResult {
  if (!membership || !model || !realizedRegionIds) {
    return incompatible("membership-or-model-unavailable");
  }
  if (membership.freshness.trim().toLowerCase() !== "current") {
    return incompatible("membership-not-current");
  }
  if (
    realizedRegionIds.length !== membership.cell_count ||
    realizedRegionIds.length !==
      model.gridShape[0] * model.gridShape[1] * model.gridShape[2] ||
    membership.counts.some((count, axis) => count !== model.gridShape[axis])
  ) {
    return incompatible("membership-cell-count-mismatch");
  }

  const definitionsResult = buildViewport3DFdmTargetDefinitions(membership);
  if (definitionsResult.status !== "ready") {
    return incompatible(definitionsResult.reason ?? "invalid-region-legend");
  }

  const legendByNumericId = new Map<number, FdmRegionMembershipResource["region_legend"][number]>();
  for (const entry of membership.region_legend) {
    legendByNumericId.set(entry.numeric_id, entry);
  }
  const objectIds = new Set(
    (membership.object_ids ?? [])
      .map(normalizeMembershipObjectId)
      .filter((value): value is string => Boolean(value)),
  );
  for (const entry of membership.region_legend) {
    const objectId = normalizeMembershipObjectId(entry.object_id);
    if (objectId) objectIds.add(objectId);
  }
  const targetIdByNumericRegionId = new Map<number, string>();
  const ownerTargetIdByNumericRegionId = new Map<number, string>();
  for (const entry of membership.region_legend) {
    const objectId = normalizeMembershipObjectId(entry.object_id);
    if (!objectId) return incompatible("invalid-region-legend");
    const ownerTarget = objectTarget(objectId);
    ownerTargetIdByNumericRegionId.set(entry.numeric_id, ownerTarget.id);
    targetIdByNumericRegionId.set(
      entry.numeric_id,
      visualizationTargetIdForSceneObject(objectId, entry.region_id),
    );
  }
  const unassignedTargetId =
    objectIds.size === 1
      ? visualizationTargetIdForSceneObject(objectIds.values().next().value as string)
      : null;
  for (const numericRegionId of realizedRegionIds) {
    if (numericRegionId === FMRM_INACTIVE_REGION_ID) continue;
    if (numericRegionId === 0) {
      if (!unassignedTargetId) {
        return incompatible("ambiguous-active-unassigned-owner");
      }
      continue;
    }
    if (!targetIdByNumericRegionId.has(numericRegionId)) {
      return incompatible("sampled-region-missing-from-legend");
    }
  }
  const viewsByTargetId = new Map<string, MutableTargetView>();
  const appendInstance = (
    target: VisualizationTargetRef,
    ownerTarget: VisualizationTargetRef,
    instanceOrdinal: number,
  ) => {
    const view = viewsByTargetId.get(target.id) ?? {
      instanceOrdinals: [],
      ownerTarget,
      target,
    };
    view.instanceOrdinals.push(instanceOrdinal);
    viewsByTargetId.set(target.id, view);
  };
  for (let instanceOrdinal = 0; instanceOrdinal < model.count; instanceOrdinal += 1) {
    const cellOrdinal = model.cellIndices[instanceOrdinal];
    const numericRegionId = model.regionIds[instanceOrdinal];
    if (
      cellOrdinal === undefined ||
      cellOrdinal >= membership.cell_count ||
      numericRegionId === undefined ||
      realizedRegionIds[cellOrdinal] !== numericRegionId
    ) {
      return incompatible("sampled-membership-out-of-range");
    }

    let ownerTarget: VisualizationTargetRef;
    let target: VisualizationTargetRef;
    if (numericRegionId === 0) {
      if (objectIds.size !== 1) {
        return incompatible("ambiguous-active-unassigned-owner");
      }
      const objectId = objectIds.values().next().value as string;
      ownerTarget = objectTarget(objectId);
      target = ownerTarget;
    } else {
      const entry = legendByNumericId.get(numericRegionId);
      if (!entry) {
        return incompatible("sampled-region-missing-from-legend");
      }
      const objectId = normalizeMembershipObjectId(entry.object_id);
      if (!objectId) return incompatible("invalid-region-legend");
      ownerTarget = objectTarget(objectId);
      target = {
        id: visualizationTargetIdForSceneObject(objectId, entry.region_id),
        kind: "region",
        label: entry.region_id,
      };
    }

    // The object target is the normal render carrier.  Region targets are
    // sparse overrides, so keep one shared-model aggregate per owner in
    // addition to the region view.  Only index arrays are partitioned; all
    // geometry remains owned by `model`.
    appendInstance(ownerTarget, ownerTarget, instanceOrdinal);
    if (target.id !== ownerTarget.id) {
      appendInstance(target, ownerTarget, instanceOrdinal);
    }
  }

  const views = Array.from(viewsByTargetId.values(), (view) => {
    const instanceOrdinals = Uint32Array.from(view.instanceOrdinals);
    const cellIndices = new Uint32Array(instanceOrdinals.length);
    for (let index = 0; index < instanceOrdinals.length; index += 1) {
      cellIndices[index] = model.cellIndices[instanceOrdinals[index] ?? 0] ?? 0;
    }
    const surfaceInstanceOrdinals = resolveExactTargetSurfaceInstances({
      instanceOrdinals,
      model,
      realizedRegionIds,
      // FDM target views are constructed only for object and region targets;
      // keep the narrow surface-partition contract explicit at this boundary.
      targetKind: view.target.kind === "region" ? "region" : "object",
      targetId: view.target.id,
      targetIdByNumericRegionId,
      ownerTargetIdByNumericRegionId,
      unassignedTargetId,
    });
    return {
      cellIndices,
      instanceOrdinals,
      ownerTarget: view.ownerTarget,
      sourceModel: model,
      surfaceInstanceOrdinals,
      target: view.target,
    };
  }).toSorted(compareTargetViews);

  return { reason: null, status: "ready", views };
}

export function memoizeViewport3DFdmTargetRenderView({
  build,
  renderKey,
  view,
}: {
  build: () => Viewport3DFdmTargetRenderView;
  renderKey: string;
  view: Viewport3DFdmTargetView;
}): Viewport3DFdmTargetRenderView {
  const cached = renderViewCache.get(view);
  if (cached?.renderKey === renderKey) return cached.view;
  const rendered = build();
  renderViewCache.set(view, { baseView: view, renderKey, view: rendered });
  return rendered;
}

function resolveExactTargetSurfaceInstances({
  instanceOrdinals,
  model,
  realizedRegionIds,
  targetKind,
  targetId,
  ownerTargetIdByNumericRegionId,
  targetIdByNumericRegionId,
  unassignedTargetId,
}: {
  instanceOrdinals: Uint32Array;
  model: FdmCuboidInstanceModel;
  realizedRegionIds: Uint32Array;
  targetKind: "object" | "region";
  targetId: string;
  ownerTargetIdByNumericRegionId: ReadonlyMap<number, string>;
  targetIdByNumericRegionId: ReadonlyMap<number, string>;
  unassignedTargetId: string | null;
}): Uint32Array {
  const [nx, ny, nz] = model.gridShape;
  const xy = nx * ny;
  const surface = new Uint32Array(instanceOrdinals.length);
  let surfaceCount = 0;
  const targetAt = (cellIndex: number): string | null => {
    const numericRegionId = realizedRegionIds[cellIndex];
    if (
      numericRegionId === undefined ||
      numericRegionId === FMRM_INACTIVE_REGION_ID
    ) {
      return null;
    }
    if (numericRegionId === 0) return unassignedTargetId;
    return (
      (targetKind === "object"
        ? ownerTargetIdByNumericRegionId.get(numericRegionId)
        : targetIdByNumericRegionId.get(numericRegionId)) ?? null
    );
  };
  for (const sourceInstance of instanceOrdinals) {
    const cellIndex = model.cellIndices[sourceInstance];
    if (cellIndex === undefined) continue;
    const ix = cellIndex % nx;
    const iy = Math.floor(cellIndex / nx) % ny;
    const iz = Math.floor(cellIndex / xy) % nz;
    const boundary =
      ix === 0 ||
      iy === 0 ||
      iz === 0 ||
      ix === nx - 1 ||
      iy === ny - 1 ||
      iz === nz - 1 ||
      [
        cellIndex - 1,
        cellIndex + 1,
        cellIndex - nx,
        cellIndex + nx,
        cellIndex - xy,
        cellIndex + xy,
      ].some((neighbor) => targetAt(neighbor) !== targetId);
    if (!boundary) continue;
    surface[surfaceCount] = sourceInstance;
    surfaceCount += 1;
  }
  if (surfaceCount > 0) return surface.slice(0, surfaceCount);
  return instanceOrdinals.length > 0
    ? Uint32Array.of(instanceOrdinals[0] ?? 0)
    : new Uint32Array();
}

export function buildViewport3DFdmTargetDefinitions(
  membership: FdmRegionMembershipResource | null | undefined,
): Viewport3DFdmTargetDefinitionsResult {
  if (!membership) {
    return { definitions: [], reason: "membership-unavailable", status: "incompatible" };
  }
  if (membership.freshness.trim().toLowerCase() !== "current") {
    return { definitions: [], reason: "membership-not-current", status: "incompatible" };
  }

  const definitions: Viewport3DFdmTargetDefinition[] = [];
  const seenNumericIds = new Set<number>();
  const seenTargetIds = new Set<string>();
  const objectIds = new Set(
    (membership.object_ids ?? [])
      .map(normalizeMembershipObjectId)
      .filter((value): value is string => Boolean(value)),
  );
  for (const entry of membership.region_legend) {
    const objectId = normalizeMembershipObjectId(entry.object_id);
    if (!objectId) {
      return { definitions: [], reason: "invalid-region-legend", status: "incompatible" };
    }
    objectIds.add(objectId);
  }
  for (const objectId of [...objectIds].toSorted()) {
    const target = objectTarget(objectId);
    definitions.push({ numericRegionId: null, ownerTarget: target, target });
    seenTargetIds.add(target.id);
  }
  for (const entry of membership.region_legend) {
    const objectId = normalizeMembershipObjectId(entry.object_id);
    if (
      !Number.isInteger(entry.numeric_id) ||
      entry.numeric_id <= 0 ||
      !objectId ||
      !entry.region_id ||
      seenNumericIds.has(entry.numeric_id)
    ) {
      return { definitions: [], reason: "invalid-region-legend", status: "incompatible" };
    }
    const ownerTarget = objectTarget(objectId);
    const target: VisualizationTargetRef = {
      id: visualizationTargetIdForSceneObject(objectId, entry.region_id),
      kind: "region",
      label: entry.region_id,
    };
    if (seenTargetIds.has(target.id)) {
      return { definitions: [], reason: "invalid-region-legend", status: "incompatible" };
    }
    seenNumericIds.add(entry.numeric_id);
    seenTargetIds.add(target.id);
    definitions.push({ numericRegionId: entry.numeric_id, ownerTarget, target });
  }
  return { definitions, reason: null, status: "ready" };
}

function incompatible(reason: string): Viewport3DFdmTargetViewsResult {
  return { reason, status: "incompatible", views: [] };
}

function normalizeMembershipObjectId(value: string): string | null {
  const normalized = value.trim().replace(/^object:/, "");
  return normalized || null;
}

function objectTarget(objectId: string): VisualizationTargetRef {
  return {
    id: visualizationTargetIdForSceneObject(objectId),
    kind: "object",
    label: objectId,
  };
}

function compareTargetViews(
  left: Viewport3DFdmTargetView,
  right: Viewport3DFdmTargetView,
): number {
  if (left.target.kind !== right.target.kind) {
    return left.target.kind === "object" ? -1 : 1;
  }
  return left.target.id.localeCompare(right.target.id);
}
