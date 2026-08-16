import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import {
  canonicalVisualizationSceneObjectId,
  isVisualizationAirboxIdentity,
} from "@/kernel/selection/selectionTypes";
import type { VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";

export type VisualizationVectorAnchorKind = "cell" | "node";

export interface VisualizationVectorCapacityDescriptor {
  anchorKind: VisualizationVectorAnchorKind;
  carrierId: string;
  exact: boolean;
  fullExact?: boolean;
  fullCount: number;
  generation: string | null;
  revision: string | number | null;
  surfaceExact?: boolean;
  surfaceCount: number;
  targetId: string;
  topologyHash: string | null;
}

export interface FdmVisualizationVectorCapacitySource {
  activeCellCount: number;
  carrierId: string;
  domainGenerationId: string | null;
  gridFingerprint: string | null;
  inactiveCellCount: number;
  kind: "fdm";
  realizedRegionIds: ArrayLike<number> | null;
  regionLegend?: readonly FdmRegionLegendEntry[];
  revision: string | number | null;
  shape: readonly [number, number, number];
}

export interface FdmNativeLayerVisualizationVectorCapacitySource
  extends Omit<
    FdmVisualizationVectorCapacitySource,
    "kind" | "realizedRegionIds" | "regionLegend"
  > {
  activeMask: ArrayLike<number> | null;
  kind: "fdm-native-layer";
}

export interface FdmMultilayerAirboxVisualizationVectorCapacitySource {
  carrierId: string;
  cellCount: number;
  carrierFingerprint: string | null;
  domainGenerationId: string | null;
  kind: "fdm-multilayer-airbox";
  revision: string | number | null;
  shape: readonly [number, number, number];
}

export interface FemVisualizationVectorCapacitySource {
  carrierId: string;
  fullExact?: boolean;
  fullNodeIndices: readonly number[];
  generation: string | null;
  kind: "fem";
  revision: string | number | null;
  surfaceExact?: boolean;
  surfaceNodeIndices: readonly number[];
  topologyHash: string | null;
}

export type VisualizationVectorCapacitySource =
  | FdmVisualizationVectorCapacitySource
  | FdmNativeLayerVisualizationVectorCapacitySource
  | FdmMultilayerAirboxVisualizationVectorCapacitySource
  | FemVisualizationVectorCapacitySource;

export interface FdmRegionLegendEntry {
  numeric_id: number;
  object_id: string;
  region_id: string;
}

export interface VisualizationVectorCapacityDescriptorInput {
  geometryScope?: "full" | "surface";
  source: VisualizationVectorCapacitySource;
  target: VisualizationTargetRef;
}

export interface FdmVisualizationVectorCapacitySourceInput {
  domain: DomainMetaResource | null | undefined;
  membership: FdmRegionMembershipResource | null | undefined;
  realizedRegionIds?: ArrayLike<number> | null;
  revision?: string | number | null;
}

/**
 * Adapt the current single-grid FDM descriptors to the target-neutral carrier
 * contract. The binary FMRM payload is optional for the full count, but is
 * required for an exact target split and Surface boundary count.
 */
export function fdmVisualizationVectorCapacitySource({
  domain,
  membership,
  realizedRegionIds = null,
  revision,
}: FdmVisualizationVectorCapacitySourceInput): FdmVisualizationVectorCapacitySource | null {
  const shape = tuple3(domain?.grid?.shape);
  if (!domain || domain.discretization.toLowerCase() !== "fdm" || !shape) {
    return null;
  }
  const total = product(shape);
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const support = membership?.magnetic_support;
  const activeCellCount = safeCount(support?.active_cell_count);
  const inactiveCellCount = safeCount(support?.inactive_cell_count);
  if (
    activeCellCount === null ||
    inactiveCellCount === null ||
    activeCellCount + inactiveCellCount !== total
  ) {
    return null;
  }
  return {
    activeCellCount,
    carrierId: `fdm:${membership?.grid_fingerprint ?? domain.domain_id}`,
    domainGenerationId: domain.generation_id,
    gridFingerprint: membership?.grid_fingerprint ?? null,
    inactiveCellCount,
    kind: "fdm",
    realizedRegionIds,
    regionLegend: membership?.region_legend?.map((entry) => ({
      numeric_id: entry.numeric_id,
      object_id: entry.object_id,
      region_id: entry.region_id,
    })),
    revision:
      revision ??
      (membership
        ? `${membership.mesh_revision}:${membership.region_membership_revision}`
        : null),
    shape,
  };
}

/** Adapt one already-validated native layer carrier without consulting DomainMeta. */
export function fdmNativeLayerVisualizationVectorCapacitySource({
  activeMask = null,
  activeCellCount,
  carrierId,
  domainGenerationId,
  gridFingerprint,
  inactiveCellCount,
  revision,
  shape,
}: Omit<FdmNativeLayerVisualizationVectorCapacitySource, "kind">): FdmNativeLayerVisualizationVectorCapacitySource | null {
  const normalizedShape = tuple3(shape);
  const total = normalizedShape ? product(normalizedShape) : 0;
  if (
    !normalizedShape ||
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    !validCount(activeCellCount) ||
    !validCount(inactiveCellCount) ||
    activeCellCount + inactiveCellCount !== total ||
    !carrierId
  ) {
    return null;
  }
  if (activeMask && activeMask.length !== total) return null;
  return {
    activeCellCount,
    activeMask,
    carrierId,
    domainGenerationId,
    gridFingerprint,
    inactiveCellCount,
    kind: "fdm-native-layer",
    revision,
    shape: normalizedShape,
  };
}

export function fdmMultilayerAirboxVisualizationVectorCapacitySource({
  carrierFingerprint,
  cellCount,
  carrierId,
  domainGenerationId,
  revision,
  shape,
}: Omit<
  FdmMultilayerAirboxVisualizationVectorCapacitySource,
  "kind"
>): FdmMultilayerAirboxVisualizationVectorCapacitySource | null {
  const normalizedShape = tuple3(shape);
  if (
    !normalizedShape ||
    !validCount(cellCount) ||
    product(normalizedShape) !== cellCount ||
    !carrierId
  ) {
    return null;
  }
  return {
    carrierFingerprint,
    carrierId,
    cellCount,
    domainGenerationId,
    kind: "fdm-multilayer-airbox",
    revision,
    shape: normalizedShape,
  };
}

/**
 * Resolve target capacity from a carrier already used by the viewport. Counts
 * are candidate anchors before sampling, so the Inspector and renderer share
 * the same budget semantics.
 */
export function resolveVisualizationVectorCapacityDescriptor({
  geometryScope = "full",
  source,
  target,
}: VisualizationVectorCapacityDescriptorInput): VisualizationVectorCapacityDescriptor | null {
  if (source.kind === "fem") {
    const fullCount = uniqueValidIndices(source.fullNodeIndices).length;
    const surfaceCount = uniqueValidIndices(source.surfaceNodeIndices).length;
    const fullExact = source.fullExact ?? true;
    const surfaceExact = source.surfaceExact ?? true;
    return descriptor({
      anchorKind: "node",
      carrierId: source.carrierId,
      exact: geometryScope === "surface" ? surfaceExact : fullExact,
      fullExact,
      fullCount,
      generation: source.generation,
      revision: source.revision,
      surfaceExact,
      surfaceCount,
      target,
      topologyHash: source.topologyHash,
    });
  }

  if (source.kind === "fdm-multilayer-airbox") {
    return descriptor({
      anchorKind: "cell",
      carrierId: source.carrierId,
      exact: true,
      fullExact: true,
      fullCount: source.cellCount,
      generation: source.domainGenerationId,
      revision: source.revision,
      surfaceExact: true,
      surfaceCount: fullGridSurfaceCellCount(source.shape),
      target,
      topologyHash: source.carrierFingerprint,
    });
  }

  const total = product(source.shape);
  if (
    source.kind === "fdm-native-layer" &&
    source.activeMask === null &&
    source.activeCellCount === total &&
    source.inactiveCellCount === 0
  ) {
    return descriptor({
      anchorKind: "cell",
      carrierId: source.carrierId,
      exact: true,
      fullExact: true,
      fullCount: source.activeCellCount,
      generation: source.domainGenerationId,
      revision: source.revision,
      surfaceExact: true,
      surfaceCount: fullGridSurfaceCellCount(source.shape),
      target,
      topologyHash: source.gridFingerprint,
      geometryScope,
    });
  }
  const selected = selectFdmCellIndices(source, target);
  const fullCount = selected
    ? selected.length
    : target.kind === "airbox"
      ? source.inactiveCellCount
      : target.kind === "fdm-domain"
        ? source.activeCellCount
        : target.kind === "fdm-native-layer"
          ? source.activeCellCount
        : 0;
  const canResolveSurface = Boolean(selected);
  const surfaceCount = selected
    ? countFdmSurfaceCells(selected, source.shape)
    : fullCount;
  const exact =
    validCount(total) &&
    validCount(fullCount) &&
    (canResolveSurface || source.shape[1] === 1 || source.shape[2] === 1);

  return descriptor({
    anchorKind: "cell",
    carrierId: source.carrierId,
    exact,
    fullExact: exact,
    fullCount,
    generation: source.domainGenerationId,
    revision: source.revision,
    surfaceExact: exact,
    surfaceCount,
    target,
    topologyHash: source.gridFingerprint,
    geometryScope,
  });
}

/** Alias kept explicit for callers that describe this as a target adapter. */
export const resolveVisualizationVectorCapacity =
  resolveVisualizationVectorCapacityDescriptor;

export function visualizationVectorBudgetRangeFromCapacity(
  descriptorValue: VisualizationVectorCapacityDescriptor | null | undefined,
  geometryScope: "full" | "surface" = "full",
): {
  availableNodeCount: number;
  exact: boolean;
  max: number;
  min: 0;
  step: 1;
} {
  const available = descriptorValue
    ? geometryScope === "surface"
      ? descriptorValue.surfaceCount
      : descriptorValue.fullCount
    : 0;
  return {
    availableNodeCount: Math.max(0, Math.floor(available)),
    exact: descriptorValue?.exact ?? false,
    max: Math.max(0, Math.floor(available)),
    min: 0,
    step: 1,
  };
}

function descriptor({
  anchorKind,
  carrierId,
  exact,
  fullExact,
  fullCount,
  generation,
  geometryScope: _geometryScope,
  revision,
  surfaceExact,
  surfaceCount,
  target,
  topologyHash,
}: {
  anchorKind: VisualizationVectorAnchorKind;
  carrierId: string;
  exact: boolean;
  fullExact?: boolean;
  fullCount: number;
  generation: string | null;
  geometryScope?: "full" | "surface";
  revision: string | number | null;
  surfaceExact?: boolean;
  surfaceCount: number;
  target: VisualizationTargetRef;
  topologyHash: string | null;
}): VisualizationVectorCapacityDescriptor {
  return {
    anchorKind,
    carrierId,
    exact,
    fullExact: fullExact ?? exact,
    fullCount: Math.max(0, Math.floor(fullCount)),
    generation,
    revision,
    surfaceExact: surfaceExact ?? exact,
    surfaceCount: Math.max(0, Math.floor(surfaceCount)),
    targetId: target.id,
    topologyHash,
  };
}

function selectFdmCellIndices(
  source: FdmVisualizationVectorCapacitySource | FdmNativeLayerVisualizationVectorCapacitySource,
  target: VisualizationTargetRef,
): number[] | null {
  if (source.kind === "fdm-native-layer") {
    if (!source.activeMask) return null;
    const selected: number[] = [];
    for (let index = 0; index < source.activeMask.length; index += 1) {
      if (source.activeMask[index] === 1) selected.push(index);
    }
    return selected;
  }
  if (!source.realizedRegionIds) return null;
  const selected: number[] = [];
  const selectedRegionIds = fdmTargetRegionIds(source, target);
  for (let index = 0; index < source.realizedRegionIds.length; index += 1) {
    const regionId = source.realizedRegionIds[index];
    if (regionId === undefined) continue;
    if (selectedRegionIds === null) {
      if (target.kind === "airbox") {
        if (regionId === FMRM_INACTIVE_REGION_ID) selected.push(index);
      } else if (target.kind === "fdm-domain" && regionId !== FMRM_INACTIVE_REGION_ID) {
        selected.push(index);
      }
    } else if (selectedRegionIds.has(regionId)) {
      selected.push(index);
    }
  }
  return selected;
}

function fdmTargetRegionIds(
  source: FdmVisualizationVectorCapacitySource,
  target: VisualizationTargetRef,
): Set<number> | null {
  if (target.kind === "airbox" || target.kind === "fdm-domain") return null;
  const legend = source.regionLegend ?? [];
  const targetObjectId = target.id.replace(/^object:/, "");
  const regionMatch = /^region:([^:]+):(.+)$/.exec(target.id);
  const regionObjectId = regionMatch ? decodeSafe(regionMatch[1] ?? "") : null;
  const regionId = regionMatch ? decodeSafe(regionMatch[2] ?? "") : null;
  const selected = new Set<number>();
  for (const entry of legend) {
    const objectMatches = canonicalVisualizationSceneObjectId(entry.object_id) ===
      canonicalVisualizationSceneObjectId(regionObjectId ?? targetObjectId);
    const regionMatches = regionId === null || decodeSafe(entry.region_id) === regionId;
    if (objectMatches && regionMatches) selected.add(entry.numeric_id);
  }
  // A homogeneous FDM object uses region id 0 (active-unassigned).
  if (selected.size === 0 && target.kind === "object") selected.add(0);
  return selected;
}

function countFdmSurfaceCells(
  selected: readonly number[],
  shape: readonly [number, number, number],
): number {
  if (selected.length === 0) return 0;
  const [nx, ny, nz] = shape;
  const xy = nx * ny;
  const selectedSet = new Set(selected);
  let count = 0;
  for (const cellIndex of selected) {
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
      ].some((neighbor) => !selectedSet.has(neighbor));
    if (boundary) count += 1;
  }
  return count > 0 ? count : 1;
}

function fullGridSurfaceCellCount(
  shape: readonly [number, number, number],
): number {
  const total = product(shape);
  const interior = Math.max(shape[0] - 2, 0) *
    Math.max(shape[1] - 2, 0) *
    Math.max(shape[2] - 2, 0);
  return Math.max(0, total - interior);
}

function uniqueValidIndices(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value >= 0))];
}

function tuple3(value: readonly number[] | null | undefined): [number, number, number] | null {
  if (
    !value ||
    value.length !== 3 ||
    value.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)
  ) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

function product(shape: readonly [number, number, number]): number {
  return shape[0] * shape[1] * shape[2];
}

function safeCount(value: number | null | undefined): number | null {
  return validCount(value) ? value : null;
}

function validCount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Build a FEM source directly from the published manifest. Node indices are
 * deduplicated because shared-domain parts intentionally overlap at interfaces.
 */
export function femVisualizationVectorCapacitySource({
  manifest,
  target,
}: {
  manifest: MeshSharedDomainManifestResource | null | undefined;
  target: VisualizationTargetRef;
}): FemVisualizationVectorCapacitySource | null {
  if (!manifest) return null;
  const parts = (manifest.mesh_parts ?? []).filter((part) =>
    femPartMatchesTarget(part, manifest, target),
  );
  if (parts.length === 0) return null;
  const fullNodeIndices = parts.flatMap((part) =>
    part.node_indices?.length
      ? part.node_indices
      : Array.from({ length: part.node_count }, (_, index) => part.node_start + index),
  );
  const surfaceNodeIndices = parts.flatMap((part) =>
    part.surface_node_indices?.length
      ? part.surface_node_indices
      : (part.surface_faces ?? []).flat(),
  );
  const exact = parts.every(
    (part) => Boolean(part.surface_node_indices?.length || part.surface_faces?.length),
  );
  const fullExact = parts.every((part) => Boolean(part.node_indices?.length));
  return {
    carrierId: manifest.mesh_id,
    fullExact,
    fullNodeIndices,
    generation: manifest.generation_id ?? null,
    kind: "fem",
    revision: manifest.revision,
    surfaceExact: exact,
    surfaceNodeIndices: exact ? surfaceNodeIndices : fullNodeIndices,
    topologyHash: manifest.topology_fingerprint ?? null,
  };
}

function femPartMatchesTarget(
  part: NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number],
  manifest: MeshSharedDomainManifestResource,
  target: VisualizationTargetRef,
): boolean {
  if (target.kind === "airbox") return isVisualizationAirboxIdentity(part);
  if (target.kind === "part") return part.id === target.id;
  if (target.kind === "region") {
    const region = manifest.regions?.find((entry) => {
      const regionId = entry.source_region_candidate_id;
      return regionId && `region:${encodeURIComponent(target.id)}`.includes(encodeURIComponent(regionId));
    });
    return Boolean(region?.mesh_part_ids?.includes(part.id));
  }
  const targetId = canonicalVisualizationSceneObjectId(target.id.replace(/^object:/, ""));
  return [part.object_id, part.geometry_id, part.id]
    .filter((value): value is string => Boolean(value))
    .some((value) => canonicalVisualizationSceneObjectId(value) === targetId);
}
