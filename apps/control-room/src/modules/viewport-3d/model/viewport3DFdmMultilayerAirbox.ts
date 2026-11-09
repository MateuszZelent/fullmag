import type { FdmMultilayerFieldVectorQuery } from "@/kernel/api/apiTypes";
import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedFieldVector,
} from "@/kernel/api/codecs";

import type { FdmMultilayerAirboxRenderDomain } from "../viewport3dDomainAdapter";
import { safeViewport3DDomainGenerationId } from "./viewport3DFieldDomainCompatibility";
import type { Viewport3DFieldResourceRequest } from "./viewport3DFieldDataPlan";

const FDM_MULTILAYER_AIRBOX_SCOPE_ID = "airbox";
const DEFAULT_FDM_MULTILAYER_AIRBOX_QUANTITY_ID = "H_demag" as const;
const FDM_MULTILAYER_AIRBOX_H_EFF_QUANTITY_ID = "H_eff" as const;

export type FdmMultilayerAirboxQuantityId =
  | typeof DEFAULT_FDM_MULTILAYER_AIRBOX_QUANTITY_ID
  | typeof FDM_MULTILAYER_AIRBOX_H_EFF_QUANTITY_ID;

/**
 * A target-only Airbox quantity remains a distinct scoped resource rather than
 * falling back to the FDM common transform grid or single-grid inactive-cell Airbox.
 */
export function buildFdmMultilayerAirboxFieldRequest(
  _domain: FdmMultilayerAirboxRenderDomain,
  maxSamples?: number | null,
  expectedQuantity: FdmMultilayerAirboxQuantityId =
    DEFAULT_FDM_MULTILAYER_AIRBOX_QUANTITY_ID,
  geometryScope?: "full" | "surface",
): Viewport3DFieldResourceRequest | null {
  if (_domain.geometryOnly || !_domain.carrierFingerprint) return null;
  const query: FdmMultilayerFieldVectorQuery = {
    component: "full",
    scope_id: FDM_MULTILAYER_AIRBOX_SCOPE_ID,
    scope_kind: "airbox",
  };
  const normalizedMaxSamples = normalizeSampleLimit(maxSamples);
  if (normalizedMaxSamples !== null) {
    query.max_samples = normalizedMaxSamples;
  }
  const surface = geometryScope === "surface";
  if (surface) query.geometry_scope = "surface";
  return {
    consumers: ["viewport-3d:fdm-multilayer-airbox"],
    quantityId: expectedQuantity,
    query,
    requestId: `fdm-multilayer-airbox:${expectedQuantity}${
      normalizedMaxSamples === null ? "" : `:max_samples=${normalizedMaxSamples}`
    }${surface ? ":geometry_scope=surface" : ""}`,
  };
}

export function shouldRequestFdmMultilayerAirboxField(
  settings: Pick<
    import("@/kernel/visualization/ObjectVisualizationController").VisualizationTargetSettings,
    "activeQuantityId" | "shaderVisible" | "vectorsVisible" | "visible"
  >,
  expectedQuantity: string =
    DEFAULT_FDM_MULTILAYER_AIRBOX_QUANTITY_ID,
  domain?: Pick<
    FdmMultilayerAirboxRenderDomain,
    "carrierFingerprint" | "geometryOnly"
  > | null,
): boolean {
  return (
    (!domain ||
      (!domain.geometryOnly && Boolean(domain.carrierFingerprint))) &&
    isFdmMultilayerAirboxQuantity(expectedQuantity) &&
    settings.visible &&
    (settings.shaderVisible || settings.vectorsVisible) &&
    settings.activeQuantityId === expectedQuantity
  );
}

export function resolveFdmMultilayerAirboxFieldVector(
  domain: Pick<
    FdmMultilayerAirboxRenderDomain,
    | "carrierFingerprint"
    | "domainGenerationId"
    | "geometryOnly"
    | "shape"
    | "totalCells"
  >,
  fieldVector: DecodedFieldVector | null | undefined,
  expectedQuantity: string =
    DEFAULT_FDM_MULTILAYER_AIRBOX_QUANTITY_ID,
): DecodedFieldVector | null {
  if (!fieldVector || domain.geometryOnly || !domain.carrierFingerprint) return null;
  if (!isFdmMultilayerAirboxQuantity(expectedQuantity)) return null;
  const fieldGenerationId = safeNonEmptyDomainGenerationId(
    fieldVector.domainGenerationId,
  );
  const domainGenerationId = safeNonEmptyDomainGenerationId(
    domain.domainGenerationId,
  );
  const sampledGrid =
    fieldVector.indexing === "sampled_node_indices" &&
    fieldVector.grid[0] === fieldVector.pointCount &&
    fieldVector.grid[1] === 1 &&
    fieldVector.grid[2] === 1;
  if (
    fieldVector.formatVersion !== 3 ||
    fieldVector.quantityId !== expectedQuantity ||
    fieldVector.scopeKind !== "airbox" ||
    fieldVector.scopeId !== FDM_MULTILAYER_AIRBOX_SCOPE_ID ||
    fieldGenerationId === null ||
    domainGenerationId === null ||
    fieldGenerationId !== domainGenerationId ||
    canonicalFingerprint(fieldVector.meshTopologyHash) !==
      canonicalFingerprint(domain.carrierFingerprint) ||
    (!sampledGrid &&
      fieldVector.grid.some((value, axis) => value !== domain.shape[axis])) ||
    fieldVector.pointCount <= 0 ||
    fieldVector.pointCount > domain.totalCells ||
    fieldVector.nComp !== 3 ||
    fieldVector.valueCount !== fieldVector.pointCount * 3 ||
    fieldVector.values.length !== fieldVector.valueCount ||
    !hasValidExplicitCellIndices(fieldVector, domain.totalCells)
  ) {
    return null;
  }
  return fieldVector;
}

interface FdmAirboxMembershipGrid {
  origin: readonly [number, number, number];
  shape: readonly [number, number, number];
  spacing: readonly [number, number, number];
  totalCells: number;
}

interface FdmAirboxMembershipLayer {
  domain: FdmAirboxMembershipGrid & { activeMaskPresent: boolean };
  /** Validated native mask from the accepted layer layout, when declared. */
  activeMask?: Uint8Array | null;
}

/** Project the union of native active cells onto the physical Airbox carrier. */
export function buildFdmMultilayerAirboxRegionIds(
  airbox: FdmAirboxMembershipGrid,
  layers: readonly FdmAirboxMembershipLayer[],
): Uint32Array | null {
  if (!validMembershipGrid(airbox) || layers.length === 0) return null;
  for (const { domain, activeMask } of layers) {
    if (!validMembershipGrid(domain)) return null;
    if (domain.activeMaskPresent
      ? activeMask?.length !== domain.totalCells
      : activeMask != null) {
      return null;
    }
  }

  const regionIds = new Uint32Array(airbox.totalCells).fill(FMRM_INACTIVE_REGION_ID);
  const [targetNx, targetNy] = airbox.shape;
  for (const { domain, activeMask } of layers) {
    const x = airboxAxisOverlap(airbox, domain, 0);
    const y = airboxAxisOverlap(airbox, domain, 1);
    const z = airboxAxisOverlap(airbox, domain, 2);
    if (x.start === x.end || y.start === y.end || z.start === z.end) continue;

    const [nativeNx, nativeNy] = domain.shape;
    for (let iz = z.start; iz < z.end; iz += 1) {
      const nativePlane = z.nativeIndexAt(iz) * nativeNy;
      for (let iy = y.start; iy < y.end; iy += 1) {
        const targetRow = (iz * targetNy + iy) * targetNx;
        if (!activeMask) {
          regionIds.fill(0, targetRow + x.start, targetRow + x.end);
          continue;
        }
        const nativeRow = (nativePlane + y.nativeIndexAt(iy)) * nativeNx;
        for (let ix = x.start; ix < x.end; ix += 1) {
          if (activeMask[nativeRow + x.nativeIndexAt(ix)] === 1) {
            regionIds[targetRow + ix] = 0;
          }
        }
      }
    }
  }
  return regionIds;
}

function validMembershipGrid({
  origin,
  shape,
  spacing,
  totalCells,
}: FdmAirboxMembershipGrid): boolean {
  return (
    Number.isSafeInteger(totalCells) &&
    totalCells > 0 &&
    totalCells <= 0xffff_ffff &&
    shape[0] * shape[1] * shape[2] === totalCells &&
    shape.every((count, axis) =>
      Number.isSafeInteger(count) &&
      count > 0 &&
      Number.isFinite(origin[axis]) &&
      Number.isFinite(spacing[axis]) &&
      spacing[axis] > 0 &&
      Number.isFinite(origin[axis] + count * spacing[axis]),
    )
  );
}

function airboxAxisOverlap(
  target: FdmAirboxMembershipGrid,
  native: FdmAirboxMembershipGrid,
  axis: 0 | 1 | 2,
): { start: number; end: number; nativeIndexAt: (targetIndex: number) => number } {
  const centerAt = (index: number) =>
    target.origin[axis] + (index + 0.5) * target.spacing[axis];
  const lower = native.origin[axis];
  const upper = lower + native.shape[axis] * native.spacing[axis];
  const nativeIndexOf = (center: number) =>
    Math.floor((center - lower) / native.spacing[axis]);
  const firstTargetIndex = (atOrPastEdge: (center: number) => boolean) => {
    let lo = 0;
    let hi = target.shape[axis];
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (atOrPastEdge(centerAt(mid))) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  // Match the API's centre arithmetic and half-open bounds, including the
  // explicit native index check when a centre rounds close to the upper edge.
  const start = firstTargetIndex((center) => center >= lower);
  const end = firstTargetIndex(
    (center) => center >= upper || nativeIndexOf(center) >= native.shape[axis],
  );
  return { start, end, nativeIndexAt: (index) => nativeIndexOf(centerAt(index)) };
}

function safeNonEmptyDomainGenerationId(value: unknown): string | null {
  const generationId = safeViewport3DDomainGenerationId(value);
  if (!generationId || generationId.trim() !== generationId) return null;
  return generationId;
}

function canonicalFingerprint(value: string | null | undefined): string | null {
  const matched = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value ?? "");
  return matched?.[1]?.toLowerCase() ?? null;
}

function hasValidExplicitCellIndices(
  fieldVector: DecodedFieldVector,
  totalCells: number,
): boolean {
  if (
    (fieldVector.indexing !== "explicit_node_indices" &&
      fieldVector.indexing !== "sampled_node_indices") ||
    !fieldVector.nodeIndices ||
    fieldVector.nodeIndices.length !== fieldVector.pointCount
  ) {
    return false;
  }
  const seen = new Set<number>();
  for (const index of fieldVector.nodeIndices) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= totalCells ||
      seen.has(index)
    ) {
      return false;
    }
    seen.add(index);
  }
  return true;
}

function normalizeSampleLimit(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function isFdmMultilayerAirboxQuantity(
  value: string,
): value is FdmMultilayerAirboxQuantityId {
  return (
    value === DEFAULT_FDM_MULTILAYER_AIRBOX_QUANTITY_ID ||
    value === FDM_MULTILAYER_AIRBOX_H_EFF_QUANTITY_ID
  );
}
