import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedFieldVector,
} from "@/kernel/api/codecs";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import type { Viewport3DVectorAnchorMode } from "../viewport3dRenderModel";

/** Number of floats per vector segment: [sx,sy,sz, ex,ey,ez, relMag] */
const FDM_VECTOR_SEGMENT_STRIDE = 7;

const CELL_VISUAL_FILL = 0.92;

export interface FdmCuboidInstanceModel {
  cellSize: [number, number, number];
  cellIndices: Uint32Array;
  centers: Float32Array;
  count: number;
  gridShape: [number, number, number];
  /** Realized numeric region IDs for sampled cells; null means authored grid fallback. */
  regionIds: Uint32Array | null;
}

export interface FdmVoxelTopographyOptions {
  amplitudeCells: number;
  component: "magnitude" | "x" | "y" | "z";
  enabled: boolean;
}

export interface FdmCuboidInstanceModelOptions {
  fieldVector?: DecodedFieldVector | null;
  realizedRegionIds?: Uint32Array | null;
  voxelFillRatio?: number;
  voxelMagnitudeThreshold?: number;
  voxelTopography?: FdmVoxelTopographyOptions;
}

export interface FdmCuboidBuildRequest {
  domain: FdmGridRenderDomain | null;
  maxVectorGlyphs: number;
  modelFieldVector?: DecodedFieldVector | null;
  realizedRegionIds?: Uint32Array | null;
  vectorAnchorMode: Viewport3DVectorAnchorMode;
  vectorField?: DecodedFieldVector | null;
  vectorScale: number;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: FdmVoxelTopographyOptions;
}

export interface FdmCuboidBuildResult {
  model: FdmCuboidInstanceModel | null;
  vectorSegments: Float32Array | null;
}

export function buildViewport3DFdmCuboid(
  request: FdmCuboidBuildRequest,
): FdmCuboidBuildResult {
  const model = buildFdmCuboidInstanceModel(request.domain, {
    fieldVector: request.modelFieldVector,
    realizedRegionIds: request.realizedRegionIds,
    voxelFillRatio: request.voxelFillRatio,
    voxelMagnitudeThreshold: request.voxelMagnitudeThreshold,
    voxelTopography: request.voxelTopography,
  });
  const vectorSegments = buildFdmVectorSegmentsUncached(
    model,
    request.vectorField,
    resolveFdmVectorGlyphScale(model, request.vectorScale),
    request.maxVectorGlyphs,
    { anchorMode: request.vectorAnchorMode },
  );
  return { model, vectorSegments };
}

export function buildFdmCuboidInstanceModel(
  domain: FdmGridRenderDomain | null,
  options: FdmCuboidInstanceModelOptions = {},
): FdmCuboidInstanceModel | null {
  if (!domain || domain.displayCellCount <= 0 || domain.totalCells <= 0) {
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
  const realizedMembershipRequested = options.realizedRegionIds !== undefined;
  if (realizedMembershipRequested && options.realizedRegionIds === null) {
    return null;
  }
  const realizedRegionIds = validRealizedRegionIds(
    options.realizedRegionIds,
    totalCells,
  );
  if (realizedMembershipRequested && !realizedRegionIds) {
    return null;
  }
  const realizedCellIndices = realizedRegionIds
    ? collectRealizedCellIndices(realizedRegionIds)
    : null;
  const candidateCount = Math.min(
    domain.displayCellCount,
    realizedCellIndices?.length ?? totalCells,
  );
  if (candidateCount <= 0) return null;
  const sampledCellIndices = new Uint32Array(candidateCount);
  let sampledCellCount = 0;

  for (let instance = 0; instance < candidateCount; instance += 1) {
    const cellIndex = realizedCellIndices
      ? (realizedCellIndices[
          Math.min(
            realizedCellIndices.length - 1,
            Math.floor((instance * realizedCellIndices.length) / candidateCount),
          )
        ] ?? 0)
      : Math.min(
          totalCells - 1,
          Math.floor((instance * totalCells) / candidateCount),
        );
    if (!cellPassesMagnitudeThreshold(options.fieldVector, cellIndex, threshold)) {
      continue;
    }
    sampledCellIndices[sampledCellCount] = cellIndex;
    sampledCellCount += 1;
  }

  const count = sampledCellCount;
  if (count <= 0) return null;

  const centers = new Float32Array(count * 3);
  const cellIndices = new Uint32Array(count);
  const sampledRegionIds = realizedRegionIds ? new Uint32Array(count) : null;

  for (let instance = 0; instance < count; instance += 1) {
    const cellIndex = sampledCellIndices[instance] ?? 0;
    cellIndices[instance] = cellIndex;
    if (sampledRegionIds) {
      sampledRegionIds[instance] = realizedRegionIds?.[cellIndex] ?? 0;
    }
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
      );
  }

  return {
    cellSize: [
      Math.max(dx * fillRatio, 1e-18),
      Math.max(dy * fillRatio, 1e-18),
      Math.max(dz * fillRatio, 1e-18),
    ],
    cellIndices,
    centers,
    count,
    gridShape: [nx, ny, nz],
    regionIds: sampledRegionIds,
  };
}

function validRealizedRegionIds(
  regionIds: Uint32Array | null | undefined,
  cellCount: number,
): Uint32Array | null {
  return regionIds && regionIds.length === cellCount ? regionIds : null;
}

function collectRealizedCellIndices(regionIds: Uint32Array): Uint32Array {
  const activeIndices = new Uint32Array(
    regionIds.reduce(
      (count, regionId) =>
        count + (regionId !== FMRM_INACTIVE_REGION_ID ? 1 : 0),
      0,
    ),
  );
  let writeOffset = 0;
  for (let cellIndex = 0; cellIndex < regionIds.length; cellIndex += 1) {
    if ((regionIds[cellIndex] ?? FMRM_INACTIVE_REGION_ID) === FMRM_INACTIVE_REGION_ID) {
      continue;
    }
    activeIndices[writeOffset] = cellIndex;
    writeOffset += 1;
  }
  return activeIndices;
}

/**
 * Returns sampled FDM cell centres for the requested display scope. The source
 * model is already capped by the domain display-cell budget, so this never
 * expands a point pass beyond the configured sampling budget.
 */
export function buildFdmPointPositions(
  model: FdmCuboidInstanceModel | null | undefined,
  geometryScope: "surface" | "full",
): Float32Array | null {
  if (!model || model.count <= 0) return null;
  if (geometryScope === "full") return model.centers;

  const [nx, ny, nz] = model.gridShape;
  let count = 0;
  for (let instance = 0; instance < model.count; instance += 1) {
    if (isFdmSurfaceCell(model.cellIndices[instance] ?? 0, nx, ny, nz)) {
      count += 1;
    }
  }
  if (count <= 0) return null;

  const positions = new Float32Array(count * 3);
  let writeOffset = 0;
  for (let instance = 0; instance < model.count; instance += 1) {
    if (!isFdmSurfaceCell(model.cellIndices[instance] ?? 0, nx, ny, nz)) {
      continue;
    }
    const sourceOffset = instance * 3;
    positions[writeOffset] = model.centers[sourceOffset] ?? 0;
    positions[writeOffset + 1] = model.centers[sourceOffset + 1] ?? 0;
    positions[writeOffset + 2] = model.centers[sourceOffset + 2] ?? 0;
    writeOffset += 3;
  }
  return positions;
}

function isFdmSurfaceCell(
  cellIndex: number,
  nx: number,
  ny: number,
  nz: number,
): boolean {
  const ix = cellIndex % nx;
  const iy = Math.floor(cellIndex / nx) % ny;
  const iz = Math.floor(cellIndex / (nx * ny)) % nz;
  return (
    ix === 0 ||
    iy === 0 ||
    iz === 0 ||
    ix === nx - 1 ||
    iy === ny - 1 ||
    iz === nz - 1
  );
}

export function buildFdmVectorSegmentsUncached(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors: number,
  options: { anchorMode?: Viewport3DVectorAnchorMode } = {},
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

  const vectorCount = Math.min(model.count, fieldVector.pointCount, maxVectors);
  const anchorMode = options.anchorMode ?? "center";
  if (vectorCount <= 0) return null;

  const stride = Math.max(1, Math.floor(model.count / vectorCount));

  let maxMagnitude = 0;
  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = Math.min(model.count - 1, vector * stride);
    const pointIndex = model.cellIndices[instance] ?? 0;
    if (pointIndex >= fieldVector.pointCount) continue;
    const offset = pointIndex * fieldVector.nComp;
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

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = Math.min(model.count - 1, vector * stride);
    const pointIndex = model.cellIndices[instance] ?? 0;
    if (pointIndex >= fieldVector.pointCount) continue;

    const positionOffset = instance * 3;
    const valueOffset = pointIndex * fieldVector.nComp;
    const target = vector * FDM_VECTOR_SEGMENT_STRIDE;
    const x = model.centers[positionOffset] ?? 0;
    const y = model.centers[positionOffset + 1] ?? 0;
    const z = model.centers[positionOffset + 2] ?? 0;
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

export function resolveFdmVectorGlyphScale(
  model: FdmCuboidInstanceModel | null,
  requestedScale: number,
): number {
  const safeScale = Math.max(requestedScale, 1e-12);
  if (!model) return safeScale;

  const maxCellSize = Math.max(...model.cellSize);
  const localCap = Math.max(maxCellSize * 0.75, 1e-12);
  return Math.min(safeScale, localCap);
}

export function estimateFdmCuboidBuildInputBytes(
  request: FdmCuboidBuildRequest,
): number {
  return (
    estimateFieldVectorBytes(request.modelFieldVector) +
    estimateFieldVectorBytes(request.vectorField) +
    (request.realizedRegionIds?.byteLength ?? 0)
  );
}

export function estimateFdmCuboidBuildOutputBytes(
  request: FdmCuboidBuildRequest,
): number {
  const modelCount = Math.max(0, request.domain?.displayCellCount ?? 0);
  const vectorCount = Math.min(
    modelCount,
    Math.max(0, request.vectorField?.pointCount ?? 0),
    Math.max(0, Math.floor(request.maxVectorGlyphs)),
  );
  return (
    modelCount * 3 * Float32Array.BYTES_PER_ELEMENT +
    modelCount * Uint32Array.BYTES_PER_ELEMENT +
    vectorCount * FDM_VECTOR_SEGMENT_STRIDE * Float32Array.BYTES_PER_ELEMENT
  );
}

export function transferablesForFdmCuboidBuildResult(
  result: FdmCuboidBuildResult,
): Transferable[] {
  const transferables: Transferable[] = [];
  addArrayBufferTransferable(transferables, result.model?.cellIndices.buffer);
  addArrayBufferTransferable(transferables, result.model?.centers.buffer);
  addArrayBufferTransferable(transferables, result.model?.regionIds?.buffer);
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
): boolean {
  if (threshold <= 0 || !fieldVector) return true;
  if (cellIndex >= fieldVector.pointCount) return false;

  const offset = cellIndex * fieldVector.nComp;
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
): number {
  if (!topography.enabled || !fieldVector || cellIndex >= fieldVector.pointCount) {
    return 0;
  }

  const offset = cellIndex * fieldVector.nComp;
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
