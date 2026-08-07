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
import { sampleFdmDisplayCellIndices } from "@/shared/domain/mesh/fdmDisplaySampling";

/** Number of floats per vector segment: [sx,sy,sz, ex,ey,ez, relMag] */
const FDM_VECTOR_SEGMENT_STRIDE = 7;

const CELL_VISUAL_FILL = 0.92;

export interface FdmCuboidInstanceModel {
  cellSize: [number, number, number];
  cellIndices: Uint32Array;
  centers: Float32Array;
  count: number;
  gridShape: [number, number, number];
  /** Realized numeric region IDs for sampled cells. */
  regionIds: Uint32Array;
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
export type FdmCuboidCellSelection = "all" | "active" | "inactive";

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
  realizedRegionIds: Uint32Array | null;
  vectorAnchorMode: Viewport3DVectorAnchorMode;
  vectorField?: DecodedFieldVector | null;
  vectorScale: number;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: FdmVoxelTopographyOptions;
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
  const model = buildFdmCuboidInstanceModel(request.domain, {
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
    resolveFdmVectorGlyphScale(model, request.vectorScale),
    request.maxVectorGlyphs,
    { anchorMode: request.vectorAnchorMode },
  );
  const vectorCellIndices = buildFdmVectorSampledCellIndices(
    model,
    request.vectorField,
    request.maxVectorGlyphs,
  );
  return { model, vectorCellIndices, vectorSegments };
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
  const cellIndices = new Uint32Array(count);
  const sampledRegionIds = new Uint32Array(count);

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
    if (selected.size < budget) {
      selected.add(cellIndex);
    } else {
      // Budget full – replace an over-represented inactive sample.
      const inactiveReplacement = [...selected]
        .find((sc) => {
          const sr = realizedRegionIds[sc] ?? FMRM_INACTIVE_REGION_ID;
          return !cellMatchesSelection(sr, cellSelection);
        });
      if (inactiveReplacement !== undefined) {
        selected.delete(inactiveReplacement);
        selected.add(cellIndex);
      }
      // If no inactive replacement found, skip (budget exhausted with only
      // matching cells).
    }
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
    selection === "all" || selection === "active" || selection === "inactive"
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
): Uint32Array {
  const candidateCount = instanceOrdinals?.length ?? model.count;
  const candidates = instanceOrdinals
    ? instanceOrdinals
    : Uint32Array.from({ length: model.count }, (_, index) => index);
  if (geometryScope === "full" || candidateCount <= 1) return candidates;

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
  if (surfaceCount > 0) return surfaceInstances.slice(0, surfaceCount);
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
    geometryScope?: "surface" | "full";
    instanceOrdinals?: Uint32Array | null;
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

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = sampledInstances[vector] ?? 0;
    const cellOrdinal = model.cellIndices[instance] ?? -1;
    const fieldIndex = fieldIndexing.resolve(cellOrdinal);
    if (fieldIndex === null) continue;

    const positionOffset = instance * 3;
    const valueOffset = fieldIndex * fieldVector.nComp;
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

/** Cell ordinals represented by the sampled FDM vector stream. */
export function buildFdmVectorSampledCellIndices(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  maxVectors: number,
  instanceOrdinals?: Uint32Array | null,
  geometryScope: "surface" | "full" = "full",
): Uint32Array | null {
  const sampledInstances = resolveFdmVectorSampledInstances(
    model,
    fieldVector,
    maxVectors,
    instanceOrdinals,
    geometryScope,
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
  );
  const validInstances: number[] = [];
  for (const instance of scopedInstances) {
    if (instance >= model.count) continue;
    const cellOrdinal = model.cellIndices[instance] ?? -1;
    if (fieldIndexing.resolve(cellOrdinal) !== null) {
      validInstances.push(instance);
    }
  }
  const vectorCount = Math.min(validInstances.length, Math.floor(maxVectors));
  if (vectorCount <= 0) return null;

  const stride = Math.max(1, Math.floor(validInstances.length / vectorCount));
  const sampledInstances = new Uint32Array(vectorCount);
  for (let vector = 0; vector < vectorCount; vector += 1) {
    sampledInstances[vector] =
      validInstances[Math.min(validInstances.length - 1, vector * stride)] ?? 0;
  }
  return sampledInstances;
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
