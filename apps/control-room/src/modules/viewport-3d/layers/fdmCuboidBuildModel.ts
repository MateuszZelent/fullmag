import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedFieldVector,
} from "@/kernel/api/codecs";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import type { Viewport3DVectorAnchorMode } from "../viewport3dRenderModel";
import {
  buildFdmFieldIndexResolver,
  type FdmFieldIndexingResult,
} from "../model/fdmFieldIndexing";
import {
  sampleFdmDisplayCellIndices,
  sampleFdmSpatialCellIndices,
} from "@/shared/domain/mesh/fdmDisplaySampling";

/** Number of floats per vector segment: [sx,sy,sz, ex,ey,ez, relMag] */
const FDM_VECTOR_SEGMENT_STRIDE = 7;

const CELL_VISUAL_FILL = 0.92;

export interface FdmCuboidInstanceModel {
  cellSize: [number, number, number];
  cellIndices: Uint32Array;
  centers: Float32Array;
  count: number;
  gridShape: [number, number, number];
  /** Three.js column-major instance matrices prepared with the model. */
  matrices: Float32Array;
  /** Stable checksum of the exact transform payload, computed in the worker. */
  matrixContentRevision: string;
  /** Stable checksum of sampled cell membership and instance order. */
  membershipRevision: string;
  /** Realized numeric region IDs for sampled cells. */
  regionIds: Uint32Array;
}

function writeFdmCuboidMatrix(
  target: Float32Array,
  instance: number,
  center: readonly [number, number, number],
  scale: readonly [number, number, number],
): void {
  const offset = instance * 16;
  target[offset] = scale[0];
  target[offset + 5] = scale[1];
  target[offset + 10] = scale[2];
  target[offset + 12] = center[0];
  target[offset + 13] = center[1];
  target[offset + 14] = center[2];
  target[offset + 15] = 1;
}

export function resolveFdmCuboidMatrixContentRevision(
  matrices: Float32Array,
): string {
  const words = new Uint32Array(
    matrices.buffer,
    matrices.byteOffset,
    matrices.byteLength / Uint32Array.BYTES_PER_ELEMENT,
  );
  let hash = 2166136261;
  for (const word of words) {
    hash = Math.imul(hash ^ word, 16777619) >>> 0;
  }
  return `matrix:${matrices.length}:${hash.toString(16)}`;
}

export function resolveFdmCuboidMembershipRevision(
  cellIndices: Uint32Array,
): string {
  let hash = 2166136261;
  for (const cellIndex of cellIndices) {
    hash = Math.imul(hash ^ cellIndex, 16777619) >>> 0;
  }
  return `membership:${cellIndices.length}:${hash.toString(16)}`;
}

export interface FdmVoxelTopographyOptions {
  amplitudeCells: number;
  component: "magnitude" | "x" | "y" | "z";
  enabled: boolean;
}

/**
 * The structured FDM lattice has one canonical membership artifact.  A
 * viewport pass must select cells from that artifact rather than treating the
 * authored universe as magnetic material.
 */
export type FdmCuboidCellSelection = "all" | "active" | "dense" | "inactive";

export interface FdmCuboidInstanceModelOptions {
  cellSelection: FdmCuboidCellSelection;
  fieldVector?: DecodedFieldVector | null;
  realizedRegionIds: Uint32Array | null;
  voxelFillRatio?: number;
  voxelMagnitudeThreshold?: number;
  voxelTopography?: FdmVoxelTopographyOptions;
}

export interface FdmCuboidBuildRequest {
  cellSelection: FdmCuboidCellSelection;
  domain: FdmGridRenderDomain | null;
  maxVectorGlyphs: number;
  modelFieldVector?: DecodedFieldVector | null;
  nativeActiveMask?: Uint8Array | null;
  realizedRegionIds: Uint32Array | null;
  vectorAnchorMode: Viewport3DVectorAnchorMode;
  vectorField?: DecodedFieldVector | null;
  /** Optional vector-only payload. When present no cuboid model is built. */
  vectorOnly?: FdmVectorOnlyBuildInput | null;
  vectorGeometryScope?: "full" | "surface";
  vectorScale: number;
  vectorSurfaceOffsetEnabled?: boolean;
  vectorSurfaceOffsetScale?: number;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: FdmVoxelTopographyOptions;
}

export interface FdmVectorOnlyBuildInput {
  anchors: Float32Array;
  cellIndices: Uint32Array;
  gridShape: [number, number, number];
  cellSize?: readonly [number, number, number];
}

/**
 * Prepare the bounded anchor carrier used by the vectors-only worker path.
 * Membership selection is shared with the full cuboid builder, so Surface and
 * Full remain a presentation filter over the same target cell identity.
 */
export function createFdmVectorOnlyBuildInput({
  cellSelection,
  domain,
  fieldVector,
  maxSamples,
  realizedRegionIds,
}: {
  cellSelection: FdmCuboidCellSelection;
  domain: FdmGridRenderDomain | null;
  fieldVector?: Pick<
    DecodedFieldVector,
    "indexing" | "nodeIndices" | "pointCount"
  > | null;
  maxSamples?: number | null;
  realizedRegionIds: Uint32Array | null;
}): FdmVectorOnlyBuildInput | null {
  if (!domain || domain.totalCells <= 0) return null;
  const [nx, ny, nz] = domain.shape;
  const totalCells = Math.min(domain.totalCells, nx * ny * nz);
  if (realizedRegionIds && realizedRegionIds.length !== totalCells) return null;
  if (
    (cellSelection === "active" || cellSelection === "inactive") &&
    !realizedRegionIds
  ) {
    return null;
  }
  const requestedSamples = normalizeFdmVectorSampleLimit(
    maxSamples,
    fieldVector?.pointCount ?? domain.displayCellCount,
  );
  const candidateCellIndices = resolveFdmVectorAnchorCandidates(
    fieldVector,
    totalCells,
    requestedSamples,
  );
  const selectedCandidates: number[] = [];
  for (const cellIndex of candidateCellIndices) {
    const regionId = realizedRegionIds?.[cellIndex] ?? FMRM_INACTIVE_REGION_ID;
    if (!cellMatchesSelection(regionId, cellSelection)) continue;
    selectedCandidates.push(cellIndex);
  }
  const selected = sampleFdmSpatialCellIndices(
    selectedCandidates,
    [nx, ny, nz],
    requestedSamples,
  );
  if (selected.length === 0) return null;
  const anchors = new Float32Array(selected.length * 3);
  const [dx, dy, dz] = domain.spacing;
  const [ox, oy, oz] = domain.origin;
  const planeStride = nx * ny;
  for (let ordinal = 0; ordinal < selected.length; ordinal += 1) {
    const cellIndex = selected[ordinal] ?? 0;
    const ix = cellIndex % nx;
    const iy = Math.floor(cellIndex / nx) % ny;
    const iz = Math.floor(cellIndex / planeStride) % nz;
    const offset = ordinal * 3;
    anchors[offset] = ox + (ix + 0.5) * dx;
    anchors[offset + 1] = oy + (iy + 0.5) * dy;
    anchors[offset + 2] = oz + (iz + 0.5) * dz;
  }
  return {
    anchors,
    cellIndices: selected,
    gridShape: [nx, ny, nz],
    cellSize: domain.spacing,
  };
}

function resolveFdmVectorAnchorCandidates(
  fieldVector: Pick<
    DecodedFieldVector,
    "indexing" | "nodeIndices" | "pointCount"
  > | null | undefined,
  totalCells: number,
  maxSamples: number,
): Uint32Array {
  const nodeIndices = fieldVector?.nodeIndices;
  if (
    nodeIndices &&
    (fieldVector?.indexing === "explicit_node_indices" ||
      fieldVector?.indexing === "sampled_node_indices") &&
    nodeIndices.length === fieldVector.pointCount
  ) {
    const candidates: number[] = [];
    const seen = new Set<number>();
    for (const value of nodeIndices) {
      const index = Number(value);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= totalCells ||
        seen.has(index)
      ) {
        continue;
      }
      seen.add(index);
      candidates.push(index);
    }
    return Uint32Array.from(candidates);
  }
  return sampleFdmDisplayCellIndices(totalCells, maxSamples);
}

function normalizeFdmVectorSampleLimit(
  requested: number | null | undefined,
  fallback: number,
): number {
  const value = requested == null ? fallback : requested;
  return Math.max(0, Math.min(Math.floor(Number.isFinite(value) ? value : 0), 0xffffffff));
}

export interface FdmCuboidBuildResult {
  model: FdmCuboidInstanceModel | null;
  /** Cell ordinals represented by the vector segment stream, in the same order. */
  vectorCellIndices: Uint32Array | null;
  vectorSegments: Float32Array | null;
}

export function buildViewport3DFdmCuboid(
  request: FdmCuboidBuildRequest,
): FdmCuboidBuildResult {
  if (request.vectorOnly) {
    const vectorSegments = buildFdmVectorSegmentsFromAnchors({
      anchorMode: request.vectorAnchorMode,
      cellSelection: request.cellSelection,
      fieldVector: request.vectorField,
      geometryScope: request.vectorGeometryScope ?? "full",
      maxVectors: request.maxVectorGlyphs,
      realizedRegionIds: request.realizedRegionIds,
      scale: request.vectorScale,
      surfaceOffsetEnabled: request.vectorSurfaceOffsetEnabled,
      surfaceOffsetScale: request.vectorSurfaceOffsetScale,
      ...request.vectorOnly,
    });
    return {
      model: null,
      vectorCellIndices: vectorSegments?.cellIndices ?? null,
      vectorSegments: vectorSegments?.segments ?? null,
    };
  }
  const model = request.cellSelection === "dense"
    ? buildFdmMaskedNativeLayerInstanceModel(
        request.domain,
        request.nativeActiveMask ?? null,
        request.voxelFillRatio,
      )
    : buildFdmCuboidInstanceModel(request.domain, {
        cellSelection: request.cellSelection,
        fieldVector: request.modelFieldVector,
        realizedRegionIds: request.realizedRegionIds,
        voxelFillRatio: request.voxelFillRatio,
        voxelMagnitudeThreshold: request.voxelMagnitudeThreshold,
        voxelTopography: request.voxelTopography,
      });
  const vectorSegments = buildFdmVectorSegmentsUncached(
    model,
    request.vectorField,
    resolveFdmVectorGlyphScale(model, request.vectorScale, request.maxVectorGlyphs),
    request.maxVectorGlyphs,
    {
      anchorMode: request.vectorAnchorMode,
      geometryScope: request.vectorGeometryScope ?? "full",
      cellSelection: request.cellSelection,
      realizedRegionIds: request.realizedRegionIds,
      surfaceOffsetEnabled: request.vectorSurfaceOffsetEnabled,
      surfaceOffsetScale: request.vectorSurfaceOffsetScale,
    },
  );
  const vectorCellIndices = buildFdmVectorSampledCellIndices(
    model,
    request.vectorField,
    request.maxVectorGlyphs,
    undefined,
    request.vectorGeometryScope ?? "full",
    request.realizedRegionIds,
    request.cellSelection,
  );
  return { model, vectorCellIndices, vectorSegments };
}

export interface FdmVectorOnlyBuildRequest extends FdmVectorOnlyBuildInput {
  anchorMode: Viewport3DVectorAnchorMode;
  cellSelection?: FdmCuboidCellSelection;
  fieldVector: DecodedFieldVector | null | undefined;
  geometryScope?: "full" | "surface";
  maxVectors: number;
  realizedRegionIds?: Uint32Array | null;
  scale: number;
  surfaceOffsetEnabled?: boolean;
  surfaceOffsetScale?: number;
}

export interface FdmVectorOnlyBuildResult {
  cellIndices: Uint32Array;
  segments: Float32Array;
}

/**
 * Builds vector segments directly from sampled anchors. This is intentionally
 * independent from the cuboid carrier so quantity switches do not rebuild or
 * copy inactive-cell matrices merely to update arrows.
 */
export function buildFdmVectorSegmentsFromAnchors(
  request: FdmVectorOnlyBuildRequest,
): FdmVectorOnlyBuildResult | null {
  const { anchors, cellIndices, fieldVector, maxVectors } = request;
  if (
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount <= 0 ||
    maxVectors <= 0 ||
    anchors.length < cellIndices.length * 3
  ) {
    return null;
  }
  const indexing = buildFdmFieldIndexResolver(
    fieldVector,
    request.gridShape[0] * request.gridShape[1] * request.gridShape[2],
  );
  if (indexing.status !== "compatible") return null;

  const candidates: number[] = [];
  for (let ordinal = 0; ordinal < cellIndices.length; ordinal += 1) {
    if (indexing.resolve(cellIndices[ordinal] ?? -1) !== null) {
      candidates.push(ordinal);
    }
  }
  const scoped = request.geometryScope === "surface"
    ? resolveAnchorSurfaceOrdinals(
        candidates,
        cellIndices,
        request.gridShape,
        request.realizedRegionIds,
        request.cellSelection,
      )
    : candidates;
  const selected = sampleFdmVectorInstanceOrdinals(
    scoped,
    cellIndices,
    request.gridShape,
    maxVectors,
  );
  if (!selected) return null;
  const count = selected.length;

  let maxMagnitude = 0;
  for (const ordinal of selected) {
    const fieldIndex = indexing.resolve(cellIndices[ordinal] ?? -1);
    if (fieldIndex === null) continue;
    const offset = fieldIndex * fieldVector.nComp;
    maxMagnitude = Math.max(
      maxMagnitude,
      Math.hypot(
        fieldVector.values[offset] ?? 0,
        fieldVector.values[offset + 1] ?? 0,
        fieldVector.values[offset + 2] ?? 0,
      ),
    );
  }
  const segments = new Float32Array(count * FDM_VECTOR_SEGMENT_STRIDE);
  const safeScale = resolveFdmVectorGlyphScaleForCellSize(
    request.cellSize,
    request.scale,
    resolveFdmVectorGlyphSamplingSpacingScale(
      request.gridShape[0] * request.gridShape[1] * request.gridShape[2],
      count,
    ),
  );
  const halfScale = safeScale / 2;
  const scaleMagnitude = Math.max(maxMagnitude, 1e-12);
  const surfaceOffsetDistance = resolveFdmSurfaceOffsetDistance(
    safeScale,
    request.anchorMode,
    request.surfaceOffsetEnabled === true && request.geometryScope === "surface",
    request.surfaceOffsetScale ?? 0,
  );
  const surfaceTargetCells =
    request.geometryScope === "surface" &&
    !hasExactFdmMembership(request.realizedRegionIds, request.gridShape)
      ? new Set(candidates.map((ordinal) => cellIndices[ordinal] ?? -1))
      : null;
  for (let index = 0; index < count; index += 1) {
    const ordinal = selected[index] ?? 0;
    const anchorOffset = ordinal * 3;
    const fieldIndex = indexing.resolve(cellIndices[ordinal] ?? -1);
    if (fieldIndex === null) continue;
    const valueOffset = fieldIndex * fieldVector.nComp;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz) || 1;
    const ux = vx / length;
    const uy = vy / length;
    const uz = vz / length;
    const target = index * FDM_VECTOR_SEGMENT_STRIDE;
    const [x, y, z] = offsetFdmVectorAnchor(
      anchors[anchorOffset] ?? 0,
      anchors[anchorOffset + 1] ?? 0,
      anchors[anchorOffset + 2] ?? 0,
      cellIndices[ordinal] ?? -1,
      request.gridShape,
      request.realizedRegionIds,
      request.cellSelection,
      surfaceTargetCells,
      surfaceOffsetDistance,
    );
    const half = request.anchorMode === "tail" ? 0 : halfScale;
    segments[target] = x - ux * half;
    segments[target + 1] = y - uy * half;
    segments[target + 2] = z - uz * half;
    segments[target + 3] = request.anchorMode === "tail" ? x + ux * safeScale : x + ux * halfScale;
    segments[target + 4] = request.anchorMode === "tail" ? y + uy * safeScale : y + uy * halfScale;
    segments[target + 5] = request.anchorMode === "tail" ? z + uz * safeScale : z + uz * halfScale;
    segments[target + 6] = length / scaleMagnitude;
  }
  return {
    cellIndices: Uint32Array.from(selected, (ordinal) => cellIndices[ordinal] ?? 0),
    segments,
  };
}

function resolveAnchorSurfaceOrdinals(
  candidates: readonly number[],
  cellIndices: Uint32Array,
  [nx, ny, nz]: readonly [number, number, number],
  realizedRegionIds: Uint32Array | null | undefined,
  cellSelection: FdmCuboidCellSelection | undefined,
): number[] {
  const exactMembership = hasExactFdmMembership(
    realizedRegionIds,
    [nx, ny, nz],
  );
  if (candidates.length <= 1 && !exactMembership) return [...candidates];
  const cells = exactMembership
    ? null
    : new Set(candidates.map((ordinal) => cellIndices[ordinal] ?? -1));
  return candidates.filter((ordinal) =>
    resolveFdmSurfaceAnchorNormal(
      cellIndices[ordinal] ?? -1,
      [nx, ny, nz],
      realizedRegionIds,
      cellSelection,
      cells,
    ) !== null,
  );
}

function hasExactFdmMembership(
  realizedRegionIds: Uint32Array | null | undefined,
  [nx, ny, nz]: readonly [number, number, number],
): realizedRegionIds is Uint32Array {
  return realizedRegionIds?.length === nx * ny * nz;
}

function resolveFdmSurfaceAnchorNormal(
  cellIndex: number,
  [nx, ny, nz]: readonly [number, number, number],
  realizedRegionIds: Uint32Array | null | undefined,
  cellSelection: FdmCuboidCellSelection | undefined,
  candidateCells: ReadonlySet<number> | null,
): [number, number, number] | null {
  const totalCells = nx * ny * nz;
  if (cellIndex < 0 || cellIndex >= totalCells) return null;
  const selection = cellSelection ?? "all";
  const hasMembership = hasExactFdmMembership(realizedRegionIds, [nx, ny, nz]);
  const targetAt = (index: number): boolean => {
    if (index < 0 || index >= totalCells) return false;
    if (hasMembership) {
      const regionId = realizedRegionIds[index] ?? FMRM_INACTIVE_REGION_ID;
      return selection === "dense" || cellMatchesSelection(regionId, selection);
    }
    return candidateCells?.has(index) ?? false;
  };
  if (!targetAt(cellIndex)) return null;

  const ix = cellIndex % nx;
  const iy = Math.floor(cellIndex / nx) % ny;
  const iz = Math.floor(cellIndex / (nx * ny)) % nz;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  if (ix === 0 || !targetAt(cellIndex - 1)) normalX -= 1;
  if (ix === nx - 1 || !targetAt(cellIndex + 1)) normalX += 1;
  if (iy === 0 || !targetAt(cellIndex - nx)) normalY -= 1;
  if (iy === ny - 1 || !targetAt(cellIndex + nx)) normalY += 1;
  const planeStride = nx * ny;
  if (iz === 0 || !targetAt(cellIndex - planeStride)) normalZ -= 1;
  if (iz === nz - 1 || !targetAt(cellIndex + planeStride)) normalZ += 1;
  const length = Math.hypot(normalX, normalY, normalZ);
  if (length <= 0) return null;
  return [normalX / length, normalY / length, normalZ / length];
}

function offsetFdmVectorAnchor(
  x: number,
  y: number,
  z: number,
  cellIndex: number,
  gridShape: readonly [number, number, number],
  realizedRegionIds: Uint32Array | null | undefined,
  cellSelection: FdmCuboidCellSelection | undefined,
  candidateCells: ReadonlySet<number> | null,
  offsetDistance: number,
): [number, number, number] {
  if (offsetDistance <= 0) return [x, y, z];
  const normal = resolveFdmSurfaceAnchorNormal(
    cellIndex,
    gridShape,
    realizedRegionIds,
    cellSelection,
    candidateCells,
  );
  if (!normal) return [x, y, z];
  return [
    x + normal[0] * offsetDistance,
    y + normal[1] * offsetDistance,
    z + normal[2] * offsetDistance,
  ];
}

function resolveFdmSurfaceOffsetDistance(
  scale: number,
  anchorMode: Viewport3DVectorAnchorMode,
  enabled: boolean,
  extraScale: number,
): number {
  if (!enabled) return 0;
  const effectiveScale = Math.max(scale, 1e-12);
  return (
    (anchorMode === "tail" ? effectiveScale : effectiveScale / 2) +
    effectiveScale * Math.max(extraScale, 0)
  );
}

export function buildFdmCuboidInstanceModel(
  domain: FdmGridRenderDomain | null,
  options: FdmCuboidInstanceModelOptions,
): FdmCuboidInstanceModel | null {
  if (!domain || domain.displayCellCount <= 0 || domain.totalCells <= 0) {
    return null;
  }
  if (!isFdmCuboidCellSelection(options.cellSelection)) {
    return null;
  }

  const [nx, ny, nz] = domain.shape;
  const [dx, dy, dz] = domain.spacing;
  const [ox, oy, oz] = domain.origin;
  const fillRatio = clampVoxelFillRatio(options.voxelFillRatio ?? 0.92);
  const threshold = Math.max(0, options.voxelMagnitudeThreshold ?? 0);
  const topography = normalizeVoxelTopography(options.voxelTopography);
  const gridCells = Math.max(nx * ny * nz, 1);
  const totalCells = Math.min(domain.totalCells, gridCells);
  const realizedRegionIds = validRealizedRegionIds(
    options.realizedRegionIds,
    totalCells,
  );
  if (!realizedRegionIds) {
    return null;
  }
  const fieldIndexing = options.fieldVector
    ? buildFdmFieldIndexResolver(options.fieldVector, totalCells)
    : null;
  const displayCellIndices = sampleFdmDisplayCellIndicesWithMinimumMembership({
    cellSelection: options.cellSelection,
    displayCellCount: domain.displayCellCount,
    fieldIndexing,
    fieldVector: options.fieldVector,
    realizedRegionIds,
    threshold,
    totalCells,
  });
  if (displayCellIndices.length <= 0) return null;
  const sampledCellIndices = new Uint32Array(displayCellIndices.length);
  let sampledCellCount = 0;

  for (const cellIndex of displayCellIndices) {
    const isInactive =
      (realizedRegionIds[cellIndex] ?? FMRM_INACTIVE_REGION_ID) ===
      FMRM_INACTIVE_REGION_ID;
    if (
      (options.cellSelection === "active" && isInactive) ||
      (options.cellSelection === "inactive" && !isInactive)
    ) {
      continue;
    }
    if (
      !cellPassesMagnitudeThreshold(
        options.fieldVector,
        cellIndex,
        threshold,
        fieldIndexing,
      )
    ) {
      continue;
    }
    sampledCellIndices[sampledCellCount] = cellIndex;
    sampledCellCount += 1;
  }

  const count = sampledCellCount;
  if (count <= 0) return null;

  const centers = new Float32Array(count * 3);
  const matrices = new Float32Array(count * 16);
  const cellIndices = new Uint32Array(count);
  const sampledRegionIds = new Uint32Array(count);

  const cellSize: [number, number, number] = [
    Math.max(dx * fillRatio, 1e-18),
    Math.max(dy * fillRatio, 1e-18),
    Math.max(dz * fillRatio, 1e-18),
  ];
  for (let instance = 0; instance < count; instance += 1) {
    const cellIndex = sampledCellIndices[instance] ?? 0;
    cellIndices[instance] = cellIndex;
    sampledRegionIds[instance] = realizedRegionIds[cellIndex] ?? 0;
    const ix = cellIndex % nx;
    const iy = Math.floor(cellIndex / nx) % ny;
    const iz = Math.floor(cellIndex / (nx * ny)) % nz;
    const target = instance * 3;

    centers[target] = ox + (ix + 0.5) * dx;
    centers[target + 1] = oy + (iy + 0.5) * dy;
    centers[target + 2] =
      oz +
      (iz + 0.5) * dz +
      resolveVoxelTopographyDisplacement(
        options.fieldVector,
        cellIndex,
        topography,
        dz,
        fieldIndexing,
      );
    writeFdmCuboidMatrix(
      matrices,
      instance,
      [centers[target] ?? 0, centers[target + 1] ?? 0, centers[target + 2] ?? 0],
      cellSize,
    );
  }

  return {
    cellSize,
    cellIndices,
    centers,
    count,
    gridShape: [nx, ny, nz],
    matrices,
    matrixContentRevision: resolveFdmCuboidMatrixContentRevision(matrices),
    membershipRevision: resolveFdmCuboidMembershipRevision(cellIndices),
    regionIds: sampledRegionIds,
  };
}

/**
 * Build a native multilayer carrier only when the planner proves that every
 * native cell is active.  The returned region ids are display-local active
 * sentinels; they are not a replacement for an FMRM mask and are never used
 * for field scope or cell selection.  Partial/unknown masks must use the
 * fail-closed path in the caller instead.
 */
export function buildFdmDenseNativeLayerInstanceModel(
  domain: FdmGridRenderDomain | null,
  voxelFillRatio = CELL_VISUAL_FILL,
): FdmCuboidInstanceModel | null {
  return buildFdmMaskedNativeLayerInstanceModel(
    domain,
    null,
    voxelFillRatio,
  );
}

/**
 * Builds one physical native-layer carrier. A supplied FMBM mask is the only
 * source of active-cell membership; absent masks are accepted only for layers
 * whose layout declares a dense native grid.
 */
export function buildFdmMaskedNativeLayerInstanceModel(
  domain: FdmGridRenderDomain | null,
  activeMask: Uint8Array | null,
  voxelFillRatio = CELL_VISUAL_FILL,
): FdmCuboidInstanceModel | null {
  if (!domain || domain.displayCellCount <= 0 || domain.totalCells <= 0) {
    return null;
  }
  const [nx, ny, nz] = domain.shape;
  const totalCells = nx * ny * nz;
  if (
    !Number.isSafeInteger(totalCells) ||
    totalCells <= 0 ||
    totalCells !== domain.totalCells
  ) {
    return null;
  }
  if (activeMask && activeMask.length !== totalCells) return null;
  const displayCellIndices = sampleNativeLayerCellIndices(
    totalCells,
    domain.displayCellCount,
    activeMask,
  );
  if (displayCellIndices.length === 0) return null;
  const centers = new Float32Array(displayCellIndices.length * 3);
  const cellIndices = new Uint32Array(displayCellIndices);
  const regionIds = new Uint32Array(displayCellIndices.length);
  const matrices = new Float32Array(displayCellIndices.length * 16);
  const [dx, dy, dz] = domain.spacing;
  const [ox, oy, oz] = domain.origin;
  const fillRatio = clampVoxelFillRatio(voxelFillRatio);
  const cellSize: [number, number, number] = [
    Math.max(dx * fillRatio, 1e-18),
    Math.max(dy * fillRatio, 1e-18),
    Math.max(dz * fillRatio, 1e-18),
  ];
  const planeStride = nx * ny;
  for (let instance = 0; instance < cellIndices.length; instance += 1) {
    const cellIndex = cellIndices[instance] ?? 0;
    const ix = cellIndex % nx;
    const iy = Math.floor(cellIndex / nx) % ny;
    const iz = Math.floor(cellIndex / planeStride) % nz;
    const offset = instance * 3;
    centers[offset] = ox + (ix + 0.5) * dx;
    centers[offset + 1] = oy + (iy + 0.5) * dy;
    centers[offset + 2] = oz + (iz + 0.5) * dz;
    writeFdmCuboidMatrix(
      matrices,
      instance,
      [centers[offset] ?? 0, centers[offset + 1] ?? 0, centers[offset + 2] ?? 0],
      cellSize,
    );
  }
  return {
    cellSize,
    cellIndices,
    centers,
    count: cellIndices.length,
    gridShape: [nx, ny, nz],
    matrices,
    matrixContentRevision: resolveFdmCuboidMatrixContentRevision(matrices),
    membershipRevision: resolveFdmCuboidMembershipRevision(cellIndices),
    regionIds,
  };
}

function sampleNativeLayerCellIndices(
  totalCells: number,
  displayCellCount: number,
  activeMask: Uint8Array | null,
): Uint32Array {
  if (!activeMask) {
    return sampleFdmDisplayCellIndices(totalCells, displayCellCount);
  }
  const activeCellCount = activeMask.reduce(
    (count, active) => count + (active === 1 ? 1 : 0),
    0,
  );
  if (activeCellCount === 0) return new Uint32Array();
  const activeCellIndices = new Uint32Array(activeCellCount);
  let activeOrdinal = 0;
  for (let cellIndex = 0; cellIndex < totalCells; cellIndex += 1) {
    if (activeMask[cellIndex] === 1) {
      activeCellIndices[activeOrdinal] = cellIndex;
      activeOrdinal += 1;
    }
  }
  const budget = Math.max(1, Math.floor(displayCellCount));
  if (activeCellCount <= budget) {
    return activeCellIndices;
  }
  const stride = Math.max(
    1,
    Math.ceil(activeCellCount / budget),
  );
  const sampled = new Uint32Array(Math.ceil(activeCellCount / stride));
  let sampledCount = 0;
  for (
    let ordinal = 0;
    ordinal < activeCellCount && sampledCount < sampled.length;
    ordinal += stride
  ) {
    sampled[sampledCount] = activeCellIndices[ordinal] ?? 0;
    sampledCount += 1;
  }
  return sampled;
}

function sampleFdmDisplayCellIndicesWithMinimumMembership({
  cellSelection,
  displayCellCount,
  fieldIndexing,
  fieldVector,
  realizedRegionIds,
  threshold,
  totalCells,
}: {
  cellSelection: FdmCuboidCellSelection;
  displayCellCount: number;
  fieldIndexing: FdmFieldIndexingResult | null;
  fieldVector: DecodedFieldVector | null | undefined;
  realizedRegionIds: Uint32Array;
  threshold: number;
  totalCells: number;
}): Uint32Array {
  const budget = Math.min(Math.max(0, Math.floor(displayCellCount)), totalCells);
  if (budget <= 0) return new Uint32Array();
  const baseSample = sampleFdmDisplayCellIndices(totalCells, budget);

  const firstCellByRegion = new Map<number, number>();
  for (let cellIndex = 0; cellIndex < totalCells; cellIndex += 1) {
    const regionId = realizedRegionIds[cellIndex] ?? FMRM_INACTIVE_REGION_ID;
    if (!cellMatchesSelection(regionId, cellSelection)) continue;
    if (
      !cellPassesMagnitudeThreshold(
        fieldVector,
        cellIndex,
        threshold,
        fieldIndexing,
      )
    ) {
      continue;
    }
    if (!firstCellByRegion.has(regionId)) {
      firstCellByRegion.set(regionId, cellIndex);
    }
  }
  if (firstCellByRegion.size === 0) return new Uint32Array();

  const selected = new Set<number>();
  const selectedCountByRegion = new Map<number, number>();
  for (const cellIndex of baseSample) {
    const regionId = realizedRegionIds[cellIndex] ?? FMRM_INACTIVE_REGION_ID;
    if (!cellMatchesSelection(regionId, cellSelection)) continue;
    if (
      !cellPassesMagnitudeThreshold(
        fieldVector,
        cellIndex,
        threshold,
        fieldIndexing,
      )
    ) {
      continue;
    }
    selected.add(cellIndex);
    selectedCountByRegion.set(
      regionId,
      (selectedCountByRegion.get(regionId) ?? 0) + 1,
    );
  }
  for (const [regionId, cellIndex] of [...firstCellByRegion].toSorted(
    ([left], [right]) => left - right,
  )) {
    if ((selectedCountByRegion.get(regionId) ?? 0) > 0) continue;
    if (selected.size < budget) {
      selected.add(cellIndex);
      selectedCountByRegion.set(regionId, 1);
      continue;
    }
    const replacement = [...selected]
      .toSorted((left, right) => right - left)
      .find((selectedCell) => {
        const selectedRegion =
          realizedRegionIds[selectedCell] ?? FMRM_INACTIVE_REGION_ID;
        return (selectedCountByRegion.get(selectedRegion) ?? 0) > 1;
      });
    if (replacement === undefined) continue;
    const replacedRegion =
      realizedRegionIds[replacement] ?? FMRM_INACTIVE_REGION_ID;
    selected.delete(replacement);
    selectedCountByRegion.set(
      replacedRegion,
      (selectedCountByRegion.get(replacedRegion) ?? 1) - 1,
    );
    selected.add(cellIndex);
    selectedCountByRegion.set(regionId, 1);
  }
  // Second pass: inject all matching cells that the stride-based sampling
  // missed.  Active cells are typically a small fraction of the grid, so
  // injecting them all keeps the budget nearly unchanged while eliminating
  // visible gaps in the ferromagnet.
  for (let cellIndex = 0; cellIndex < totalCells; cellIndex += 1) {
    if (selected.has(cellIndex)) continue;
    const regionId = realizedRegionIds[cellIndex] ?? FMRM_INACTIVE_REGION_ID;
    if (!cellMatchesSelection(regionId, cellSelection)) continue;
    if (
      !cellPassesMagnitudeThreshold(
        fieldVector,
        cellIndex,
        threshold,
        fieldIndexing,
      )
    ) {
      continue;
    }
    if (selected.size < budget) selected.add(cellIndex);
  }
  return Uint32Array.from([...selected].toSorted((left, right) => left - right));
}

function cellMatchesSelection(
  regionId: number,
  selection: FdmCuboidCellSelection,
): boolean {
  const inactive = regionId === FMRM_INACTIVE_REGION_ID;
  return (
    selection === "all" ||
    (selection === "active" && !inactive) ||
    (selection === "inactive" && inactive)
  );
}

function validRealizedRegionIds(
  regionIds: Uint32Array | null | undefined,
  cellCount: number,
): Uint32Array | null {
  return regionIds && regionIds.length === cellCount ? regionIds : null;
}

function isFdmCuboidCellSelection(
  selection: unknown,
): selection is FdmCuboidCellSelection {
  return (
    selection === "all" ||
    selection === "active" ||
    selection === "dense" ||
    selection === "inactive"
  );
}

/**
 * Returns sampled FDM cell centres for the requested display scope. The source
 * model is already capped by the domain display-cell budget, so this never
 * expands a point pass beyond the configured sampling budget.
 */
export function buildFdmPointPositions(
  model: FdmCuboidInstanceModel | null | undefined,
  geometryScope: "surface" | "full",
  instanceOrdinals?: Uint32Array | null,
): Float32Array | null {
  if (!model || model.count <= 0) return null;
  if (geometryScope === "full" && !instanceOrdinals) return model.centers;

  const scopedInstances = resolveFdmGeometryScopeInstanceOrdinals(
    model,
    geometryScope,
    instanceOrdinals,
  );
  const count = scopedInstances.length;
  if (count <= 0) return null;

  const positions = new Float32Array(count * 3);
  for (let instance = 0; instance < scopedInstances.length; instance += 1) {
    const sourceInstance = scopedInstances[instance] ?? 0;
    const sourceOffset = sourceInstance * 3;
    const writeOffset = instance * 3;
    positions[writeOffset] = model.centers[sourceOffset] ?? 0;
    positions[writeOffset + 1] = model.centers[sourceOffset + 1] ?? 0;
    positions[writeOffset + 2] = model.centers[sourceOffset + 2] ?? 0;
  }
  return positions;
}

export function resolveFdmGeometryScopeInstanceOrdinals(
  model: FdmCuboidInstanceModel,
  geometryScope: "surface" | "full",
  instanceOrdinals?: Uint32Array | null,
  realizedRegionIds?: Uint32Array | null,
  cellSelection?: FdmCuboidCellSelection,
): Uint32Array {
  const candidateCount = instanceOrdinals?.length ?? model.count;
  const candidates = instanceOrdinals
    ? instanceOrdinals
    : Uint32Array.from({ length: model.count }, (_, index) => index);
  if (geometryScope === "full") return candidates;

  const exactMembership = hasExactFdmMembership(
    realizedRegionIds,
    model.gridShape,
  );
  if (exactMembership) {
    const surfaceInstances = new Uint32Array(candidateCount);
    let surfaceCount = 0;
    for (const sourceInstance of candidates) {
      if (
        sourceInstance === undefined ||
        sourceInstance >= model.count ||
        resolveFdmSurfaceAnchorNormal(
          model.cellIndices[sourceInstance] ?? -1,
          model.gridShape,
          realizedRegionIds,
          cellSelection,
          null,
        ) === null
      ) {
        continue;
      }
      surfaceInstances[surfaceCount] = sourceInstance;
      surfaceCount += 1;
    }
    return surfaceInstances.slice(0, surfaceCount);
  }
  if (candidateCount <= 1) return candidates;

  const targetCells = new Set<number>();
  for (let index = 0; index < candidateCount; index += 1) {
    const sourceInstance = candidates[index];
    if (sourceInstance === undefined || sourceInstance >= model.count) continue;
    targetCells.add(model.cellIndices[sourceInstance] ?? -1);
  }
  const surfaceInstances = new Uint32Array(candidateCount);
  let surfaceCount = 0;
  for (let index = 0; index < candidateCount; index += 1) {
    const sourceInstance = candidates[index];
    if (sourceInstance === undefined || sourceInstance >= model.count) continue;
    if (
      isFdmTargetSurfaceCell(
        model.cellIndices[sourceInstance] ?? -1,
        model.gridShape,
        targetCells,
      )
    ) {
      surfaceInstances[surfaceCount] = sourceInstance;
      surfaceCount += 1;
    }
  }
  if (surfaceCount > 0 || exactMembership) {
    return surfaceInstances.slice(0, surfaceCount);
  }
  const fallback = candidates[0];
  return fallback === undefined ? new Uint32Array() : Uint32Array.of(fallback);
}

function isFdmTargetSurfaceCell(
  cellIndex: number,
  [nx, ny, nz]: readonly [number, number, number],
  targetCells: ReadonlySet<number>,
): boolean {
  if (cellIndex < 0) return false;
  const ix = cellIndex % nx;
  const iy = Math.floor(cellIndex / nx) % ny;
  const iz = Math.floor(cellIndex / (nx * ny)) % nz;
  if (ix === 0 || iy === 0 || iz === 0 || ix === nx - 1 || iy === ny - 1 || iz === nz - 1) {
    return true;
  }
  const xy = nx * ny;
  return ![
    cellIndex - 1,
    cellIndex + 1,
    cellIndex - nx,
    cellIndex + nx,
    cellIndex - xy,
    cellIndex + xy,
  ].every((neighbor) => targetCells.has(neighbor));
}

export function buildFdmVectorSegmentsUncached(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors: number,
  options: {
    anchorMode?: Viewport3DVectorAnchorMode;
    cellSelection?: FdmCuboidCellSelection;
    geometryScope?: "surface" | "full";
    instanceOrdinals?: Uint32Array | null;
    realizedRegionIds?: Uint32Array | null;
    surfaceOffsetEnabled?: boolean;
    surfaceOffsetScale?: number;
  } = {},
): Float32Array | null {
  if (
    !model ||
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    maxVectors <= 0
  ) {
    return null;
  }

  const sampledInstances = resolveFdmVectorSampledInstances(
    model,
    fieldVector,
    maxVectors,
    options.instanceOrdinals,
    options.geometryScope,
    options.realizedRegionIds,
    options.cellSelection,
  );
  if (!sampledInstances) return null;
  const vectorCount = sampledInstances.length;
  const anchorMode = options.anchorMode ?? "center";
  if (vectorCount <= 0) return null;
  const fieldIndexing = buildFdmFieldIndexResolver(
    fieldVector,
    model.gridShape[0] * model.gridShape[1] * model.gridShape[2],
  );
  if (fieldIndexing.status !== "compatible") return null;

  let maxMagnitude = 0;
  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = sampledInstances[vector] ?? 0;
    const cellOrdinal = model.cellIndices[instance] ?? -1;
    const fieldIndex = fieldIndexing.resolve(cellOrdinal);
    if (fieldIndex === null) continue;
    const offset = fieldIndex * fieldVector.nComp;
    const magnitude = Math.hypot(
      fieldVector.values[offset] ?? 0,
      fieldVector.values[offset + 1] ?? 0,
      fieldVector.values[offset + 2] ?? 0,
    );
    maxMagnitude = Math.max(maxMagnitude, magnitude);
  }

  const scaleMagnitude = Math.max(maxMagnitude, 1e-12);
  const halfScale = scale / 2;
  const segments = new Float32Array(vectorCount * FDM_VECTOR_SEGMENT_STRIDE);
  const surfaceTargetCells =
    options.geometryScope === "surface"
      && !hasExactFdmMembership(options.realizedRegionIds, model.gridShape)
      ? new Set(
          (options.instanceOrdinals ??
            Uint32Array.from({ length: model.count }, (_, index) => index)
          ).map((instance) => model.cellIndices[instance] ?? -1),
        )
      : null;
  const surfaceOffsetDistance = resolveFdmSurfaceOffsetDistance(
    scale,
    anchorMode,
    options.surfaceOffsetEnabled === true && options.geometryScope === "surface",
    options.surfaceOffsetScale ?? 0,
  );

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = sampledInstances[vector] ?? 0;
    const cellOrdinal = model.cellIndices[instance] ?? -1;
    const fieldIndex = fieldIndexing.resolve(cellOrdinal);
    if (fieldIndex === null) continue;

    const positionOffset = instance * 3;
    const valueOffset = fieldIndex * fieldVector.nComp;
    const target = vector * FDM_VECTOR_SEGMENT_STRIDE;
    const [x, y, z] = offsetFdmVectorAnchor(
      model.centers[positionOffset] ?? 0,
      model.centers[positionOffset + 1] ?? 0,
      model.centers[positionOffset + 2] ?? 0,
      cellOrdinal,
      model.gridShape,
      options.realizedRegionIds,
      options.cellSelection,
      surfaceTargetCells,
      surfaceOffsetDistance,
    );
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz) || 1;
    const ux = vx / length;
    const uy = vy / length;
    const uz = vz / length;

    if (anchorMode === "tail") {
      segments[target] = x;
      segments[target + 1] = y;
      segments[target + 2] = z;
      segments[target + 3] = x + ux * scale;
      segments[target + 4] = y + uy * scale;
      segments[target + 5] = z + uz * scale;
    } else {
      segments[target] = x - ux * halfScale;
      segments[target + 1] = y - uy * halfScale;
      segments[target + 2] = z - uz * halfScale;
      segments[target + 3] = x + ux * halfScale;
      segments[target + 4] = y + uy * halfScale;
      segments[target + 5] = z + uz * halfScale;
    }
    segments[target + 6] = length / scaleMagnitude;
  }

  return segments;
}

/** Cell ordinals represented by the sampled FDM vector stream. */
export function buildFdmVectorSampledCellIndices(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  maxVectors: number,
  instanceOrdinals?: Uint32Array | null,
  geometryScope: "surface" | "full" = "full",
  realizedRegionIds?: Uint32Array | null,
  cellSelection?: FdmCuboidCellSelection,
): Uint32Array | null {
  const sampledInstances = resolveFdmVectorSampledInstances(
    model,
    fieldVector,
    maxVectors,
    instanceOrdinals,
    geometryScope,
    realizedRegionIds,
    cellSelection,
  );
  if (!sampledInstances || !model) return null;

  const cellIndices = new Uint32Array(sampledInstances.length);
  for (let index = 0; index < sampledInstances.length; index += 1) {
    cellIndices[index] = model.cellIndices[sampledInstances[index] ?? 0] ?? 0;
  }
  return cellIndices;
}

function resolveFdmVectorSampledInstances(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  maxVectors: number,
  instanceOrdinals?: Uint32Array | null,
  geometryScope: "surface" | "full" = "full",
  realizedRegionIds?: Uint32Array | null,
  cellSelection?: FdmCuboidCellSelection,
): Uint32Array | null {
  if (
    !model ||
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    maxVectors <= 0
  ) {
    return null;
  }

  const fieldIndexing = buildFdmFieldIndexResolver(
    fieldVector,
    model.gridShape[0] * model.gridShape[1] * model.gridShape[2],
  );
  if (fieldIndexing.status !== "compatible") return null;

  const scopedInstances = resolveFdmGeometryScopeInstanceOrdinals(
    model,
    geometryScope,
    instanceOrdinals,
    realizedRegionIds,
    cellSelection,
  );
  const validInstances: number[] = [];
  for (const instance of scopedInstances) {
    if (instance >= model.count) continue;
    const cellOrdinal = model.cellIndices[instance] ?? -1;
    if (fieldIndexing.resolve(cellOrdinal) !== null) {
      validInstances.push(instance);
    }
  }
  return sampleFdmVectorInstanceOrdinals(
    validInstances,
    model.cellIndices,
    model.gridShape,
    maxVectors,
  );
}
function sampleFdmVectorInstanceOrdinals(
  instanceOrdinals: ArrayLike<number>,
  cellIndices: Uint32Array,
  gridShape: readonly [number, number, number],
  maxVectors: number,
): Uint32Array | null {
  const budget = Math.max(
    0,
    Math.floor(Number.isFinite(maxVectors) ? maxVectors : 0),
  );
  if (budget <= 0 || instanceOrdinals.length === 0) return null;

  const totalCells = gridShape[0] * gridShape[1] * gridShape[2];
  const candidateCells: number[] = [];
  const ordinalByCell = new Map<number, number>();
  for (let index = 0; index < instanceOrdinals.length; index += 1) {
    const ordinal = Number(instanceOrdinals[index]);
    const cellIndex = cellIndices[ordinal] ?? -1;
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= cellIndices.length ||
      !Number.isSafeInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= totalCells ||
      ordinalByCell.has(cellIndex)
    ) {
      continue;
    }
    candidateCells.push(cellIndex);
    ordinalByCell.set(cellIndex, ordinal);
  }
  const sampledCellIndices = sampleFdmSpatialCellIndices(
    candidateCells,
    gridShape,
    budget,
  );
  if (sampledCellIndices.length === 0) return null;

  const sampledInstances = new Uint32Array(sampledCellIndices.length);
  for (let index = 0; index < sampledCellIndices.length; index += 1) {
    sampledInstances[index] =
      ordinalByCell.get(sampledCellIndices[index] ?? -1) ?? 0;
  }
  return sampledInstances;
}

export function resolveFdmVectorGlyphScaleForCellSize(
  cellSize: readonly [number, number, number] | null | undefined,
  requestedScale: number,
  samplingSpacingScale = 1,
): number {
  const safeScale = Number.isFinite(requestedScale)
    ? Math.max(requestedScale, 1e-12)
    : 1e-12;
  if (!cellSize) return safeScale;
  const safeSamplingSpacingScale = Number.isFinite(samplingSpacingScale)
    ? Math.max(samplingSpacingScale, 1)
    : 1;
  const maxCellSize = Math.max(
    ...cellSize.filter((size) => Number.isFinite(size) && size > 0),
    1e-12,
  );
  return Math.min(
    safeScale,
    maxCellSize * 0.75 * safeSamplingSpacingScale,
  );
}

export function resolveFdmVectorGlyphSamplingSpacingScale(
  carrierCount: number,
  renderedGlyphCount: number,
): number {
  const safeCarrierCount = Math.max(
    1,
    Math.floor(Number.isFinite(carrierCount) ? carrierCount : 0),
  );
  const safeRenderedGlyphCount = Math.max(
    1,
    Math.min(
      safeCarrierCount,
      Math.floor(
        Number.isFinite(renderedGlyphCount) ? renderedGlyphCount : 0,
      ),
    ),
  );
  return Math.cbrt(safeCarrierCount / safeRenderedGlyphCount);
}

export function resolveFdmVectorGlyphScale(
  model: FdmCuboidInstanceModel | null,
  requestedScale: number,
  maxVectorGlyphs: number,
): number {
  const modelCount = model?.count ?? 0;
  const renderedGlyphCount = Math.min(
    modelCount,
    Math.max(
      1,
      Math.floor(Number.isFinite(maxVectorGlyphs) ? maxVectorGlyphs : 0),
    ),
  );
  return resolveFdmVectorGlyphScaleForCellSize(
    model?.cellSize,
    requestedScale,
    resolveFdmVectorGlyphSamplingSpacingScale(modelCount, renderedGlyphCount),
  );
}

export function estimateFdmCuboidBuildInputBytes(
  request: FdmCuboidBuildRequest,
): number {
  return (
    estimateFieldVectorBytes(request.modelFieldVector) +
    estimateFieldVectorBytes(request.vectorField) +
    (request.nativeActiveMask?.byteLength ?? 0) +
    (request.realizedRegionIds?.byteLength ?? 0)
    + (request.vectorOnly?.anchors.byteLength ?? 0)
    + (request.vectorOnly?.cellIndices.byteLength ?? 0)
  );
}

export function estimateFdmCuboidBuildOutputBytes(
  request: FdmCuboidBuildRequest,
): number {
  const modelCount = request.vectorOnly
    ? 0
    : Math.max(0, request.domain?.displayCellCount ?? 0);
  const vectorCount = Math.min(
    modelCount,
    Math.max(0, request.vectorField?.pointCount ?? 0),
    Math.max(0, Math.floor(request.maxVectorGlyphs)),
  );
  return (
    modelCount * 3 * Float32Array.BYTES_PER_ELEMENT +
    modelCount * 16 * Float32Array.BYTES_PER_ELEMENT +
    modelCount * Uint32Array.BYTES_PER_ELEMENT +
    modelCount * Uint32Array.BYTES_PER_ELEMENT +
    vectorCount * Uint32Array.BYTES_PER_ELEMENT +
    vectorCount * FDM_VECTOR_SEGMENT_STRIDE * Float32Array.BYTES_PER_ELEMENT
  );
}

export function transferablesForFdmCuboidBuildResult(
  result: FdmCuboidBuildResult,
): Transferable[] {
  const transferables: Transferable[] = [];
  addArrayBufferTransferable(transferables, result.model?.cellIndices.buffer);
  addArrayBufferTransferable(transferables, result.model?.centers.buffer);
  addArrayBufferTransferable(transferables, result.model?.matrices.buffer);
  addArrayBufferTransferable(transferables, result.model?.regionIds?.buffer);
  addArrayBufferTransferable(transferables, result.vectorCellIndices?.buffer);
  addArrayBufferTransferable(transferables, result.vectorSegments?.buffer);
  return transferables;
}

function clampVoxelFillRatio(value: number): number {
  if (!Number.isFinite(value)) return CELL_VISUAL_FILL;
  return Math.min(Math.max(value, 0.1), 1);
}

function cellPassesMagnitudeThreshold(
  fieldVector: DecodedFieldVector | null | undefined,
  cellIndex: number,
  threshold: number,
  fieldIndexing: FdmFieldIndexingResult | null,
): boolean {
  if (threshold <= 0 || !fieldVector) return true;
  if (!fieldIndexing || fieldIndexing.status !== "compatible") return true;
  const fieldIndex = fieldIndexing.resolve(cellIndex);
  if (fieldIndex === null) return false;

  const offset = fieldIndex * fieldVector.nComp;
  if (fieldVector.nComp === 1) {
    return Math.abs(fieldVector.values[offset] ?? 0) >= threshold;
  }

  const magnitude = Math.hypot(
    fieldVector.values[offset] ?? 0,
    fieldVector.values[offset + 1] ?? 0,
    fieldVector.values[offset + 2] ?? 0,
  );
  return magnitude >= threshold;
}

function normalizeVoxelTopography(
  value: FdmVoxelTopographyOptions | null | undefined,
): FdmVoxelTopographyOptions {
  if (!value?.enabled) {
    return { amplitudeCells: 0, component: "z", enabled: false };
  }
  const amplitudeCells = Number.isFinite(value.amplitudeCells)
    ? Math.max(-16, Math.min(16, value.amplitudeCells))
    : 0;
  const component =
    value.component === "x" ||
    value.component === "y" ||
    value.component === "z" ||
    value.component === "magnitude"
      ? value.component
      : "z";
  return {
    amplitudeCells,
    component,
    enabled: amplitudeCells !== 0,
  };
}

function resolveVoxelTopographyDisplacement(
  fieldVector: DecodedFieldVector | null | undefined,
  cellIndex: number,
  topography: FdmVoxelTopographyOptions,
  cellHeight: number,
  fieldIndexing: FdmFieldIndexingResult | null,
): number {
  if (
    !topography.enabled ||
    !fieldVector ||
    !fieldIndexing ||
    fieldIndexing.status !== "compatible"
  ) {
    return 0;
  }

  const fieldIndex = fieldIndexing.resolve(cellIndex);
  if (fieldIndex === null) return 0;
  const offset = fieldIndex * fieldVector.nComp;
  const x = fieldVector.values[offset] ?? 0;
  const y = fieldVector.nComp > 1 ? fieldVector.values[offset + 1] ?? 0 : 0;
  const z = fieldVector.nComp > 2 ? fieldVector.values[offset + 2] ?? 0 : 0;
  const value =
    topography.component === "x"
      ? x
      : topography.component === "y"
        ? y
        : topography.component === "z"
          ? z
          : Math.hypot(x, y, z);

  return value * topography.amplitudeCells * cellHeight;
}

function estimateFieldVectorBytes(
  fieldVector: DecodedFieldVector | null | undefined,
): number {
  return fieldVector?.values.byteLength ?? 0;
}

function addArrayBufferTransferable(
  transferables: Transferable[],
  buffer: ArrayBufferLike | undefined,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}
