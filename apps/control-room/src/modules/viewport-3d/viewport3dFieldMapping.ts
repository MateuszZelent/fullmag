import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { SurfaceFieldProjectionMode } from "@/kernel/visualization/ObjectVisualizationController";

import { buildFdmFieldIndexResolver } from "./model/fdmFieldIndexing";

import {
  normalizeViewport3DVectorColorMode,
  resolveViewport3DVectorColorRgb,
  resolveViewport3DVectorColorScalar,
  type Viewport3DScalarColorRange,
  type Viewport3DVectorColorMode,
} from "./viewport3dVectorColoring";

export interface ScalarRange {
  max: number;
  min: number;
}

export interface ScalarRangeDiagnostics extends ScalarRange {
  finiteCount: number;
  mean: number;
  nonFiniteCount: number;
  outlierDominated: boolean;
  p01: number;
  p99: number;
  zeroCount: number;
}

export interface ScalarColorBuffer {
  buildKey?: string;
  colors: Float32Array;
  colorMode?: string;
  colorPalette?: string;
  complexImagValues?: Float32Array;
  complexPhaseRad?: number;
  complexRealValues?: Float32Array;
  wavevectorKf?: [number, number, number];
  cellOrigin?: [number, number, number];
  floquetSpatialConvention?: string;
  phasorConvention?: string;
  quantityId?: string;
  range: ScalarRange;
  sourceFieldBufferId?: string | null;
  sourceResourceKey?: string | null;
  rangeDiagnostics?: ScalarRangeDiagnostics;
  degradedFaceCount?: number;
  faceCount?: number;
  geometryRole?: "face_expanded_surface" | "indexed_topology";
  lowNormFaceCount?: number;
  missingNodeCount?: number;
  projectedBinCount?: number;
  projectedSamplesPerBinMax?: number;
  projectedSamplesPerBinMean?: number;
  projectedSamplesPerBinMin?: number;
  projectionSuitability?:
    | "degraded_insufficient_depth_samples"
    | "degraded_non_world_z_thin_film"
    | "world_z_thin_film";
  projectionAxis?: "z";
  projectionMode?: SurfaceFieldProjectionMode;
  projectionTolerance?: number;
  rangeSource?: "face_values" | "field_meta" | "manual" | "projected_values" | "raw_nodal";
  scalarValues?: Float32Array;
  targetRevision?: string;
  topologyRevision?: string;
  vectorValues?: Float32Array;
}

const scalarColorBufferFallbackKeys = new WeakMap<ScalarColorBuffer, string>();
let nextScalarColorBufferFallbackKey = 0;

export function resolveViewport3DScalarColorBufferKey(
  scalarBuffer: ScalarColorBuffer,
): string;
export function resolveViewport3DScalarColorBufferKey(
  scalarBuffer: null | undefined,
): null;
export function resolveViewport3DScalarColorBufferKey(
  scalarBuffer: ScalarColorBuffer | null | undefined,
): string | null;
export function resolveViewport3DScalarColorBufferKey(
  scalarBuffer: ScalarColorBuffer | null | undefined,
): string | null {
  if (!scalarBuffer) return null;
  if (scalarBuffer.buildKey !== undefined) return scalarBuffer.buildKey;

  const existingKey = scalarColorBufferFallbackKeys.get(scalarBuffer);
  if (existingKey) return existingKey;

  nextScalarColorBufferFallbackKey += 1;
  const key = `scalar-buffer:runtime:${nextScalarColorBufferFallbackKey}`;
  scalarColorBufferFallbackKeys.set(scalarBuffer, key);
  return key;
}

export interface ChunkedFieldTransformOptions {
  chunkSize?: number;
  colorMode?: string;
  colorPalette?: string;
  scalarRange?: ScalarRange | null;
  shaderOnly?: boolean;
  signal?: AbortSignal;
  yieldToMain?: () => Promise<void>;
}

export const VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT = 50_000;
const LOW_CONFIDENCE_ORIENTATION_RGB = [0.6, 0.6, 0.6] as const;
const MISSING_PROJECTED_DATA_RGB = [0.5, 0.5, 0.5] as const;
const REDUCED_MAGNETIZATION_LOW_NORM_EPSILON = 1e-3;

export function fieldTransformNeedsChunking(
  pointCount: number,
  threshold = VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
): boolean {
  return pointCount > threshold;
}

export function buildVertexScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  vertexCount: number,
  maxSynchronousPoints = VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
  colorMode = "magnitude",
  colorPalette = "viridis",
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    fieldVector.pointCount > vertexCount ||
    fieldVector.pointCount === 0 ||
    !fieldVectorSupportsScalarColorMode(fieldVector, resolvedColorMode) ||
    resolvedColorMode === "monochrome" ||
    fieldTransformNeedsChunking(fieldVector.pointCount, maxSynchronousPoints)
  ) {
    return null;
  }

  return buildVertexScalarColorsUnchecked(
    fieldVector,
    vertexCount,
    resolvedColorMode,
    colorPalette,
    scalarRange,
  );
}

export function buildSampledScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  pointIndices: Uint32Array | null | undefined,
  colorMode = "magnitude",
  colorPalette = "viridis",
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    !pointIndices ||
    pointIndices.length === 0 ||
    fieldVector.pointCount === 0 ||
    !fieldVectorSupportsScalarColorMode(fieldVector, resolvedColorMode) ||
    resolvedColorMode === "monochrome"
  ) {
    return null;
  }

  const range = resolveScalarRange(fieldVector, resolvedColorMode);
  const colors = new Float32Array(pointIndices.length * 3);
  const scalarValues = shaderScalarModeSupports(resolvedColorMode)
    ? new Float32Array(pointIndices.length)
    : undefined;

  for (let index = 0; index < pointIndices.length; index += 1) {
    const pointIndex = pointIndices[index] ?? 0;
    if (pointIndex >= fieldVector.pointCount) {
      const target = index * 3;
      colors[target] = 0.5;
      colors[target + 1] = 0.5;
      colors[target + 2] = 0.5;
      continue;
    }
    if (scalarValues) {
      scalarValues[index] = scalarAt(fieldVector, pointIndex, resolvedColorMode);
    }
    const [red, green, blue] = colorAt(
      fieldVector,
      pointIndex,
      resolvedColorMode,
      range,
      colorPalette,
    );
    const target = index * 3;
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }

  return {
    colors,
    colorMode: resolvedColorMode,
    colorPalette,
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: resolveScalarRangeDiagnostics(
      fieldVector,
      resolvedColorMode,
    ),
    scalarValues,
  };
}

/**
 * Builds scalar colors for FDM cuboids whose point indices are domain cell
 * ordinals. FMVP full/legacy payloads are accepted only when their point count
 * proves direct full-domain order; explicit/sampled payloads use nodeIndices as
 * the cell-ordinal mapping. Invalid metadata fails closed so the layer keeps a
 * neutral material instead of painting a wrong cell with a neighboring value.
 */
export function buildFdmSampledScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  cellOrdinals: Uint32Array | null | undefined,
  domainCellCount: number,
  colorMode = "magnitude",
  colorPalette = "viridis",
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    !cellOrdinals ||
    cellOrdinals.length === 0 ||
    fieldVector.pointCount === 0 ||
    !fieldVectorSupportsScalarColorMode(fieldVector, resolvedColorMode) ||
    resolvedColorMode === "monochrome"
  ) {
    return null;
  }

  const indexing = buildFdmFieldIndexResolver(fieldVector, domainCellCount);
  if (indexing.status !== "compatible") return null;

  const range =
    resolveProvidedScalarRange(scalarRange) ??
    resolveScalarRange(fieldVector, resolvedColorMode);
  const colors = new Float32Array(cellOrdinals.length * 3);
  const scalarValues = shaderScalarModeSupports(resolvedColorMode)
    ? new Float32Array(cellOrdinals.length)
    : undefined;

  for (let index = 0; index < cellOrdinals.length; index += 1) {
    const fieldIndex = indexing.resolve(cellOrdinals[index] ?? -1);
    const target = index * 3;
    if (fieldIndex === null) {
      colors[target] = 0.5;
      colors[target + 1] = 0.5;
      colors[target + 2] = 0.5;
      continue;
    }
    if (scalarValues) {
      scalarValues[index] = scalarAt(fieldVector, fieldIndex, resolvedColorMode);
    }
    const [red, green, blue] = colorAt(
      fieldVector,
      fieldIndex,
      resolvedColorMode,
      range,
      colorPalette,
    );
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }

  return {
    colors,
    colorMode: resolvedColorMode,
    colorPalette,
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: resolveScalarRangeDiagnostics(
      fieldVector,
      resolvedColorMode,
    ),
    scalarValues,
  };
}

export function buildMappedVertexScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  targetNodeIndices: Uint32Array | null | undefined,
  vertexCount: number,
  maxSynchronousPoints = VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
  colorMode = "magnitude",
  colorPalette = "viridis",
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    !targetNodeIndices ||
    targetNodeIndices.length < fieldVector.pointCount ||
    fieldVector.pointCount === 0 ||
    !fieldVectorSupportsScalarColorMode(fieldVector, resolvedColorMode) ||
    resolvedColorMode === "monochrome" ||
    fieldTransformNeedsChunking(fieldVector.pointCount, maxSynchronousPoints)
  ) {
    return null;
  }

  const range =
    resolveProvidedScalarRange(scalarRange) ??
    resolveScalarRange(fieldVector, resolvedColorMode);
  const colors = new Float32Array(vertexCount * 3);
  const scalarValues = shaderScalarModeSupports(resolvedColorMode)
    ? new Float32Array(vertexCount)
    : undefined;

  for (let index = 0; index < fieldVector.pointCount; index += 1) {
    const nodeIndex = targetNodeIndices[index] ?? -1;
    if (nodeIndex < 0 || nodeIndex >= vertexCount) {
      continue;
    }
    if (scalarValues) {
      scalarValues[nodeIndex] = scalarAt(fieldVector, index, resolvedColorMode);
    }
    const [red, green, blue] = colorAt(
      fieldVector,
      index,
      resolvedColorMode,
      range,
      colorPalette,
    );
    const target = nodeIndex * 3;
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }

  return {
    colors,
    colorMode: resolvedColorMode,
    colorPalette,
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: resolveScalarRangeDiagnostics(
      fieldVector,
      resolvedColorMode,
    ),
    scalarValues,
  };
}

export function buildSurfaceFaceScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  surfaceIndices: Uint32Array | null | undefined,
  vertexCount: number,
  colorMode = "magnitude",
  colorPalette = "viridis",
  scalarRange?: ScalarRange | null,
  maxSynchronousPoints = VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
  targetNodeIndices?: ArrayLike<number> | null,
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    !surfaceIndices ||
    surfaceIndices.length === 0 ||
    surfaceIndices.length % 3 !== 0 ||
    fieldVector.pointCount === 0 ||
    !fieldVectorSupportsScalarColorMode(fieldVector, resolvedColorMode) ||
    resolvedColorMode === "monochrome" ||
    fieldTransformNeedsChunking(
      Math.max(fieldVector.pointCount, surfaceIndices.length),
      maxSynchronousPoints,
    )
  ) {
    return null;
  }

  const nodeToFieldIndex = buildNodeToFieldIndexMap(
    fieldVector,
    vertexCount,
    targetNodeIndices,
  );
  if (!nodeToFieldIndex) return null;

  const faceCount = surfaceIndices.length / 3;
  const faceVectors = new Float64Array(faceCount * 3);
  const faceScalars = new Float64Array(faceCount);
  let lowNormFaceCount = 0;
  let degradedFaceCount = 0;
  let missingNodeCount = 0;
  const degradedFaces = new Uint8Array(faceCount);
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const surfaceOffset = faceIndex * 3;
    const nodeA = surfaceIndices[surfaceOffset] ?? -1;
    const nodeB = surfaceIndices[surfaceOffset + 1] ?? -1;
    const nodeC = surfaceIndices[surfaceOffset + 2] ?? -1;
    const fieldA = nodeToFieldIndex.get(nodeA);
    const fieldB = nodeToFieldIndex.get(nodeB);
    const fieldC = nodeToFieldIndex.get(nodeC);
    if (fieldA === undefined || fieldB === undefined || fieldC === undefined) {
      degradedFaces[faceIndex] = 1;
      degradedFaceCount += 1;
      missingNodeCount += [fieldA, fieldB, fieldC].filter(
        (fieldIndex) => fieldIndex === undefined,
      ).length;
      continue;
    }
    const [x, y, z] = averageFieldVectorComponents(
      fieldVector,
      fieldA,
      fieldB,
      fieldC,
    );
    const vectorOffset = faceIndex * 3;
    faceVectors[vectorOffset] = x;
    faceVectors[vectorOffset + 1] = y;
    faceVectors[vectorOffset + 2] = z;
    if (isLowConfidenceOrientationVector(resolvedColorMode, x, y, z)) {
      lowNormFaceCount += 1;
    }
    faceScalars[faceIndex] = scalarFromComponents(
      resolvedColorMode,
      x,
      y,
      z,
      fieldVector.nComp,
    );
  }

  const range =
    resolveProvidedScalarRange(scalarRange) ??
    scalarRangeFromValues(faceScalars);
  const colors = new Float32Array(surfaceIndices.length * 3);
  const scalarValues = shaderScalarModeSupports(resolvedColorMode)
    ? new Float32Array(surfaceIndices.length)
    : undefined;
  const vectorValues = shaderVectorModeSupports(resolvedColorMode, fieldVector)
    ? new Float32Array(surfaceIndices.length * 3)
    : undefined;

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const vectorOffset = faceIndex * 3;
    const x = faceVectors[vectorOffset] ?? 0;
    const y = faceVectors[vectorOffset + 1] ?? 0;
    const z = faceVectors[vectorOffset + 2] ?? 0;
    const scalar = faceScalars[faceIndex] ?? 0;
    const rgb = degradedFaces[faceIndex]
      ? MISSING_PROJECTED_DATA_RGB
      : colorProjectedVector(
          resolvedColorMode,
          x,
          y,
          z,
          range,
          scalar,
          colorPalette,
        );
    for (let corner = 0; corner < 3; corner += 1) {
      const targetIndex = faceIndex * 3 + corner;
      const colorOffset = targetIndex * 3;
      colors[colorOffset] = rgb[0];
      colors[colorOffset + 1] = rgb[1];
      colors[colorOffset + 2] = rgb[2];
      if (scalarValues) {
        scalarValues[targetIndex] = scalar;
      }
      if (vectorValues) {
        vectorValues[colorOffset] = x;
        vectorValues[colorOffset + 1] = y;
        vectorValues[colorOffset + 2] = z;
      }
    }
  }

  return {
    colors,
    colorMode: resolvedColorMode,
    colorPalette,
    degradedFaceCount,
    faceCount,
    geometryRole: "face_expanded_surface",
    lowNormFaceCount,
    missingNodeCount,
    projectionMode: "surface_faces",
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: scalarRangeDiagnosticsFromValues(faceScalars),
    rangeSource: "face_values",
    scalarValues,
    vectorValues,
  };
}

export function buildThicknessAverageZScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  positions: ArrayLike<number> | null | undefined,
  surfaceIndices: Uint32Array | null | undefined,
  vertexCount: number,
  colorMode = "magnitude",
  colorPalette = "viridis",
  scalarRange?: ScalarRange | null,
  maxSynchronousPoints = VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
  targetNodeIndices?: ArrayLike<number> | null,
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    !positions ||
    positions.length < vertexCount * 3 ||
    !surfaceIndices ||
    surfaceIndices.length === 0 ||
    surfaceIndices.length % 3 !== 0 ||
    fieldVector.pointCount === 0 ||
    !fieldVectorSupportsScalarColorMode(fieldVector, resolvedColorMode) ||
    resolvedColorMode === "monochrome" ||
    fieldTransformNeedsChunking(
      Math.max(fieldVector.pointCount, surfaceIndices.length),
      maxSynchronousPoints,
    )
  ) {
    return null;
  }

  const nodeToFieldIndex = buildNodeToFieldIndexMap(
    fieldVector,
    vertexCount,
    targetNodeIndices,
  );
  if (!nodeToFieldIndex) return null;
  const projection = buildWorldZProjectedVectors({
    fieldVector,
    nodeToFieldIndex,
    positions,
    vertexCount,
  });
  if (!projection) return null;
  const projectedVectors = projection.vectors;

  const faceCount = surfaceIndices.length / 3;
  const faceVectors = new Float64Array(faceCount * 3);
  const faceScalars = new Float64Array(faceCount);
  let lowNormFaceCount = 0;
  let degradedFaceCount = 0;
  let missingNodeCount = 0;
  const degradedFaces = new Uint8Array(faceCount);
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const surfaceOffset = faceIndex * 3;
    const nodeA = surfaceIndices[surfaceOffset] ?? -1;
    const nodeB = surfaceIndices[surfaceOffset + 1] ?? -1;
    const nodeC = surfaceIndices[surfaceOffset + 2] ?? -1;
    const vectorA = projectedVectors.get(nodeA);
    const vectorB = projectedVectors.get(nodeB);
    const vectorC = projectedVectors.get(nodeC);
    if (!vectorA || !vectorB || !vectorC) {
      degradedFaces[faceIndex] = 1;
      degradedFaceCount += 1;
      if (!vectorA) missingNodeCount += 1;
      if (!vectorB) missingNodeCount += 1;
      if (!vectorC) missingNodeCount += 1;
      continue;
    }
    const x = (vectorA[0] + vectorB[0] + vectorC[0]) / 3;
    const y = (vectorA[1] + vectorB[1] + vectorC[1]) / 3;
    const z = (vectorA[2] + vectorB[2] + vectorC[2]) / 3;
    const vectorOffset = faceIndex * 3;
    faceVectors[vectorOffset] = x;
    faceVectors[vectorOffset + 1] = y;
    faceVectors[vectorOffset + 2] = z;
    if (isLowConfidenceOrientationVector(resolvedColorMode, x, y, z)) {
      lowNormFaceCount += 1;
    }
    faceScalars[faceIndex] = scalarFromComponents(
      resolvedColorMode,
      x,
      y,
      z,
      fieldVector.nComp,
    );
  }

  const range =
    resolveProvidedScalarRange(scalarRange) ??
    scalarRangeFromValues(faceScalars);
  const colors = new Float32Array(surfaceIndices.length * 3);
  const scalarValues = shaderScalarModeSupports(resolvedColorMode)
    ? new Float32Array(surfaceIndices.length)
    : undefined;
  const vectorValues = shaderVectorModeSupports(resolvedColorMode, fieldVector)
    ? new Float32Array(surfaceIndices.length * 3)
    : undefined;

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const vectorOffset = faceIndex * 3;
    const x = faceVectors[vectorOffset] ?? 0;
    const y = faceVectors[vectorOffset + 1] ?? 0;
    const z = faceVectors[vectorOffset + 2] ?? 0;
    const scalar = faceScalars[faceIndex] ?? 0;
    const rgb = degradedFaces[faceIndex]
      ? MISSING_PROJECTED_DATA_RGB
      : colorProjectedVector(
          resolvedColorMode,
          x,
          y,
          z,
          range,
          scalar,
          colorPalette,
        );
    for (let corner = 0; corner < 3; corner += 1) {
      const targetIndex = faceIndex * 3 + corner;
      const colorOffset = targetIndex * 3;
      colors[colorOffset] = rgb[0];
      colors[colorOffset + 1] = rgb[1];
      colors[colorOffset + 2] = rgb[2];
      if (scalarValues) {
        scalarValues[targetIndex] = scalar;
      }
      if (vectorValues) {
        vectorValues[colorOffset] = x;
        vectorValues[colorOffset + 1] = y;
        vectorValues[colorOffset + 2] = z;
      }
    }
  }

  return {
    colors,
    colorMode: resolvedColorMode,
    colorPalette,
    degradedFaceCount,
    faceCount,
    geometryRole: "face_expanded_surface",
    lowNormFaceCount,
    missingNodeCount,
    projectedBinCount: projection.binCount,
    projectedSamplesPerBinMax: projection.samplesPerBinMax,
    projectedSamplesPerBinMean: projection.samplesPerBinMean,
    projectedSamplesPerBinMin: projection.samplesPerBinMin,
    projectionAxis: "z",
    projectionMode: "thickness_average_z",
    projectionSuitability: projection.suitability,
    projectionTolerance: projection.tolerance,
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: scalarRangeDiagnosticsFromValues(faceScalars),
    rangeSource: "projected_values",
    scalarValues,
    vectorValues,
  };
}

export async function buildVertexScalarColorsChunked(
  fieldVector: DecodedFieldVector,
  options: ChunkedFieldTransformOptions = {},
): Promise<ScalarColorBuffer | null> {
  const chunkSize = Math.max(Math.floor(options.chunkSize ?? 10_000), 1);
  const colorMode = normalizeViewport3DVectorColorMode(
    options.colorMode,
    "magnitude",
  );
  const colorPalette = options.colorPalette ?? "viridis";
  if (!fieldVectorSupportsScalarColorMode(fieldVector, colorMode)) {
    return null;
  }
  const shaderScalarMode = shaderScalarModeSupports(colorMode);
  const shaderVectorMode = shaderVectorModeSupports(colorMode, fieldVector);
  const shaderOnly = Boolean(
    options.shaderOnly && (shaderScalarMode || shaderVectorMode),
  );
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());
  const range =
    shaderOnly && shaderVectorMode
      ? { max: 1, min: 0 }
      : resolveProvidedScalarRange(options.scalarRange) ??
        (await resolveScalarRangeChunked(
            fieldVector,
            colorMode,
            chunkSize,
            options.signal,
            yieldToMain,
          ));
  const colors = shaderOnly
    ? new Float32Array(0)
    : new Float32Array(fieldVector.pointCount * 3);
  const scalarValues = shaderScalarMode
    ? new Float32Array(fieldVector.pointCount)
    : undefined;
  const vectorValues =
    shaderOnly && shaderVectorMode
      ? new Float32Array(fieldVector.pointCount * 3)
      : undefined;

  for (let start = 0; start < fieldVector.pointCount; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, fieldVector.pointCount);
    writeScalarColors(
      fieldVector,
      colors,
      range,
      start,
      end,
      colorMode,
      colorPalette,
      scalarValues,
      vectorValues,
    );
    if (end < fieldVector.pointCount) {
      await yieldToMain();
    }
  }

  throwIfAborted(options.signal);
  return {
    colors,
    colorMode,
    colorPalette,
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: resolveScalarRangeDiagnostics(fieldVector, colorMode),
    scalarValues,
    vectorValues,
  };
}

export function fieldVectorSupportsScalarColorMode(
  fieldVector: Pick<DecodedFieldVector, "nComp">,
  colorMode: Viewport3DVectorColorMode,
): boolean {
  return colorMode !== "orientation" || fieldVector.nComp >= 3;
}

export function fieldVectorUsesDirectNodeOrder(
  fieldVector:
    | Pick<DecodedFieldVector, "indexing" | "nodeIndices" | "pointCount">
    | null
    | undefined,
  nodeCount: number,
): boolean {
  if (
    !fieldVector ||
    fieldVector.pointCount !== nodeCount ||
    fieldVector.indexing === "sampled_node_indices"
  ) {
    return false;
  }

  const nodeIndices = fieldVector.nodeIndices;
  if (!nodeIndices) return fieldVector.indexing !== "explicit_node_indices";
  if (nodeIndices.length !== fieldVector.pointCount) return false;
  for (let index = 0; index < nodeIndices.length; index += 1) {
    if (nodeIndices[index] !== index) return false;
  }
  return true;
}

function resolveProvidedScalarRange(
  range: ScalarRange | null | undefined,
): ScalarRange | null {
  if (
    !range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max)
  ) {
    return null;
  }
  return {
    max: range.max,
    min: range.min,
  };
}

/**
 * Chunked version of resolveScalarRange that yields to main thread between
 * chunks.  Prevents the synchronous O(N) range scan from blocking the UI
 * for large meshes (> 50K points).
 */
async function resolveScalarRangeChunked(
  fieldVector: DecodedFieldVector,
  colorMode: string,
  chunkSize: number,
  signal?: AbortSignal,
  yieldToMain?: () => Promise<void>,
): Promise<ScalarRange> {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  let min = Infinity;
  let max = -Infinity;

  for (let start = 0; start < fieldVector.pointCount; start += chunkSize) {
    throwIfAborted(signal);
    const end = Math.min(start + chunkSize, fieldVector.pointCount);
    for (let index = start; index < end; index += 1) {
      const value = scalarAt(fieldVector, index, resolvedColorMode);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (end < fieldVector.pointCount && yieldToMain) {
      await yieldToMain();
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { max: 0, min: 0 };
  }

  return { max, min };
}

export function resolveScalarRange(
  fieldVector: DecodedFieldVector,
  colorMode = "magnitude",
): ScalarRange {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  let min = Infinity;
  let max = -Infinity;

  for (let index = 0; index < fieldVector.pointCount; index += 1) {
    const value = scalarAt(fieldVector, index, resolvedColorMode);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { max: 0, min: 0 };
  }

  return { max, min };
}

export function resolveScalarRangeDiagnostics(
  fieldVector: DecodedFieldVector,
  colorMode = "magnitude",
): ScalarRangeDiagnostics {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  const finiteValues: number[] = [];
  let max = -Infinity;
  let min = Infinity;
  let nonFiniteCount = 0;
  let sum = 0;
  let zeroCount = 0;

  for (let index = 0; index < fieldVector.pointCount; index += 1) {
    const value = scalarAt(fieldVector, index, resolvedColorMode);
    if (!Number.isFinite(value)) {
      nonFiniteCount += 1;
      continue;
    }
    finiteValues.push(value);
    if (value === 0) zeroCount += 1;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }

  const finiteCount = finiteValues.length;
  if (finiteCount === 0) {
    return {
      finiteCount: 0,
      max: 0,
      mean: 0,
      min: 0,
      nonFiniteCount,
      outlierDominated: false,
      p01: 0,
      p99: 0,
      zeroCount,
    };
  }

  finiteValues.sort((left, right) => left - right);
  const p01 = finiteValues[percentileIndex(finiteCount, 0.01)] ?? min;
  const p99 = finiteValues[percentileIndex(finiteCount, 0.99)] ?? max;
  const centralAbs = Math.max(Math.abs(p01), Math.abs(p99), 1e-12);
  const maxAbs = Math.max(Math.abs(min), Math.abs(max));

  return {
    finiteCount,
    max,
    mean: sum / finiteCount,
    min,
    nonFiniteCount,
    outlierDominated: finiteCount >= 3 && maxAbs > 50 * centralAbs,
    p01,
    p99,
    zeroCount,
  };
}

function buildNodeToFieldIndexMap(
  fieldVector: DecodedFieldVector,
  vertexCount: number,
  targetNodeIndices?: ArrayLike<number> | null,
): Map<number, number> | null {
  const map = new Map<number, number>();
  if (fieldVector.nodeIndices) {
    if (
      (fieldVector.indexing === "explicit_node_indices" ||
        fieldVector.indexing === "sampled_node_indices") &&
      fieldVector.nodeIndices.length !== fieldVector.pointCount
    ) {
      return null;
    }
    for (let fieldIndex = 0; fieldIndex < fieldVector.pointCount; fieldIndex += 1) {
      const nodeIndex = fieldVector.nodeIndices[fieldIndex];
      if (
        nodeIndex === undefined ||
        nodeIndex < 0 ||
        nodeIndex >= vertexCount
      ) {
        return null;
      }
      map.set(nodeIndex, fieldIndex);
    }
    return map;
  }

  if (
    fieldVector.indexing === "explicit_node_indices" ||
    fieldVector.indexing === "sampled_node_indices"
  ) {
    return targetNodeIndices &&
      targetNodeIndices.length === fieldVector.pointCount
      ? buildNodeToFieldIndexMapFromIndices(
          targetNodeIndices,
          fieldVector.pointCount,
          vertexCount,
        )
      : null;
  }
  if (targetNodeIndices) {
    return targetNodeIndices.length === fieldVector.pointCount
      ? buildNodeToFieldIndexMapFromIndices(
          targetNodeIndices,
          fieldVector.pointCount,
          vertexCount,
        )
      : null;
  }
  for (let fieldIndex = 0; fieldIndex < fieldVector.pointCount; fieldIndex += 1) {
    map.set(fieldIndex, fieldIndex);
  }
  return map;
}

function buildNodeToFieldIndexMapFromIndices(
  targetNodeIndices: ArrayLike<number>,
  pointCount: number,
  vertexCount: number,
): Map<number, number> | null {
  if (targetNodeIndices.length !== pointCount) return null;
  const map = new Map<number, number>();
  for (let fieldIndex = 0; fieldIndex < pointCount; fieldIndex += 1) {
    const nodeIndex = targetNodeIndices[fieldIndex];
    if (
      nodeIndex === undefined ||
      !Number.isInteger(nodeIndex) ||
      nodeIndex < 0 ||
      nodeIndex >= vertexCount
    ) {
      return null;
    }
    map.set(nodeIndex, fieldIndex);
  }
  return map;
}

function buildWorldZProjectedVectors({
  fieldVector,
  nodeToFieldIndex,
  positions,
  vertexCount,
}: {
  fieldVector: DecodedFieldVector;
  nodeToFieldIndex: ReadonlyMap<number, number>;
  positions: ArrayLike<number>;
  vertexCount: number;
}): {
  binCount: number;
  samplesPerBinMax: number;
  samplesPerBinMean: number;
  samplesPerBinMin: number;
  suitability: NonNullable<ScalarColorBuffer["projectionSuitability"]>;
  tolerance: number;
  vectors: Map<number, readonly [number, number, number]>;
} | null {
  const bounds = worldZProjectionBounds(positions, vertexCount);
  if (!bounds) return null;
  const tolerance = worldZProjectionTolerance(bounds);
  if (!Number.isFinite(tolerance) || tolerance <= 0) return null;
  const columns = new Map<
    string,
    { count: number; x: number; y: number; z: number }
  >();
  const nodeColumnKeys = new Map<number, string>();

  for (const [nodeIndex, fieldIndex] of nodeToFieldIndex) {
    if (nodeIndex < 0 || nodeIndex >= vertexCount) return null;
    const positionOffset = nodeIndex * 3;
    const x = positions[positionOffset] ?? Number.NaN;
    const y = positions[positionOffset + 1] ?? Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const key = `${Math.round(x / tolerance)}:${Math.round(y / tolerance)}`;
    const column = columns.get(key) ?? { count: 0, x: 0, y: 0, z: 0 };
    column.count += 1;
    column.x += fieldComponent(fieldVector, fieldIndex, 0);
    column.y += fieldComponent(fieldVector, fieldIndex, 1);
    column.z += fieldComponent(fieldVector, fieldIndex, 2);
    columns.set(key, column);
    nodeColumnKeys.set(nodeIndex, key);
  }

  const columnVectors = new Map<string, readonly [number, number, number]>();
  let samplesPerBinMax = 0;
  let samplesPerBinMin = Infinity;
  let samplesPerBinSum = 0;
  for (const [key, column] of Array.from(columns).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (column.count <= 0) return null;
    samplesPerBinMax = Math.max(samplesPerBinMax, column.count);
    samplesPerBinMin = Math.min(samplesPerBinMin, column.count);
    samplesPerBinSum += column.count;
    columnVectors.set(key, [
      column.x / column.count,
      column.y / column.count,
      column.z / column.count,
    ]);
  }

  const projected = new Map<number, readonly [number, number, number]>();
  for (const [nodeIndex, key] of nodeColumnKeys) {
    const vector = columnVectors.get(key);
    if (!vector) return null;
    projected.set(nodeIndex, vector);
  }
  const binCount = columnVectors.size;
  return {
    binCount,
    samplesPerBinMax,
    samplesPerBinMean: binCount > 0 ? samplesPerBinSum / binCount : 0,
    samplesPerBinMin: Number.isFinite(samplesPerBinMin)
      ? samplesPerBinMin
      : 0,
    suitability: resolveWorldZProjectionSuitability({
      samplesPerBinMin: Number.isFinite(samplesPerBinMin)
        ? samplesPerBinMin
        : 0,
      tolerance,
      xExtent: bounds.maxX - bounds.minX,
      yExtent: bounds.maxY - bounds.minY,
      zExtent: bounds.maxZ - bounds.minZ,
    }),
    tolerance,
    vectors: projected,
  };
}

function worldZProjectionBounds(
  positions: ArrayLike<number>,
  vertexCount: number,
): {
  maxX: number;
  maxY: number;
  maxZ: number;
  minX: number;
  minY: number;
  minZ: number;
} | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let nodeIndex = 0; nodeIndex < vertexCount; nodeIndex += 1) {
    const offset = nodeIndex * 3;
    const x = positions[offset] ?? Number.NaN;
    const y = positions[offset + 1] ?? Number.NaN;
    const z = positions[offset + 2] ?? Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxZ)
  ) {
    return null;
  }
  return { maxX, maxY, maxZ, minX, minY, minZ };
}

function worldZProjectionTolerance(
  bounds: NonNullable<ReturnType<typeof worldZProjectionBounds>>,
): number {
  const diagonal = Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  );
  return Math.max(diagonal * 1e-9, 1e-12);
}

function resolveWorldZProjectionSuitability({
  samplesPerBinMin,
  tolerance,
  xExtent,
  yExtent,
  zExtent,
}: {
  samplesPerBinMin: number;
  tolerance: number;
  xExtent: number;
  yExtent: number;
  zExtent: number;
}): NonNullable<ScalarColorBuffer["projectionSuitability"]> {
  if (zExtent > Math.min(xExtent, yExtent) + tolerance) {
    return "degraded_non_world_z_thin_film";
  }
  if (samplesPerBinMin < 2) {
    return "degraded_insufficient_depth_samples";
  }
  return "world_z_thin_film";
}

function averageFieldVectorComponents(
  fieldVector: DecodedFieldVector,
  fieldA: number,
  fieldB: number,
  fieldC: number,
): [number, number, number] {
  return [
    averageFieldComponent(fieldVector, fieldA, fieldB, fieldC, 0),
    averageFieldComponent(fieldVector, fieldA, fieldB, fieldC, 1),
    averageFieldComponent(fieldVector, fieldA, fieldB, fieldC, 2),
  ];
}

function averageFieldComponent(
  fieldVector: DecodedFieldVector,
  fieldA: number,
  fieldB: number,
  fieldC: number,
  component: number,
): number {
  if (component >= fieldVector.nComp) return 0;
  return (
    ((fieldVector.values[fieldA * fieldVector.nComp + component] ?? 0) +
      (fieldVector.values[fieldB * fieldVector.nComp + component] ?? 0) +
      (fieldVector.values[fieldC * fieldVector.nComp + component] ?? 0)) /
    3
  );
}

function fieldComponent(
  fieldVector: DecodedFieldVector,
  fieldIndex: number,
  component: number,
): number {
  if (component >= fieldVector.nComp) return 0;
  return fieldVector.values[fieldIndex * fieldVector.nComp + component] ?? 0;
}

function scalarFromComponents(
  colorMode: Viewport3DVectorColorMode,
  x: number,
  y: number,
  z: number,
  componentCount: number,
): number {
  if (componentCount === 1) return x;
  return resolveViewport3DVectorColorScalar(colorMode, x, y, z);
}

function colorProjectedVector(
  colorMode: Viewport3DVectorColorMode,
  x: number,
  y: number,
  z: number,
  range: Viewport3DScalarColorRange,
  scalar: number,
  colorPalette: string,
): readonly [number, number, number] {
  if (isLowConfidenceOrientationVector(colorMode, x, y, z)) {
    return LOW_CONFIDENCE_ORIENTATION_RGB;
  }
  return (
    resolveViewport3DVectorColorRgb(
      colorMode,
      x,
      y,
      z,
      range,
      normalizeScalarValue(scalar, range),
      colorPalette,
    ) ?? [1, 1, 1]
  );
}

function isLowConfidenceOrientationVector(
  colorMode: Viewport3DVectorColorMode,
  x: number,
  y: number,
  z: number,
): boolean {
  return (
    colorMode === "orientation" &&
    Math.hypot(x, y, z) < REDUCED_MAGNETIZATION_LOW_NORM_EPSILON
  );
}

function scalarRangeFromValues(values: ArrayLike<number>): ScalarRange {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { max: 0, min: 0 };
  }
  return { max, min };
}

function scalarRangeDiagnosticsFromValues(
  values: ArrayLike<number>,
): ScalarRangeDiagnostics {
  const finiteValues: number[] = [];
  let max = -Infinity;
  let min = Infinity;
  let nonFiniteCount = 0;
  let sum = 0;
  let zeroCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      nonFiniteCount += 1;
      continue;
    }
    finiteValues.push(value);
    if (value === 0) zeroCount += 1;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  const finiteCount = finiteValues.length;
  if (finiteCount === 0) {
    return {
      finiteCount: 0,
      max: 0,
      mean: 0,
      min: 0,
      nonFiniteCount,
      outlierDominated: false,
      p01: 0,
      p99: 0,
      zeroCount,
    };
  }
  finiteValues.sort((left, right) => left - right);
  const p01 = finiteValues[percentileIndex(finiteCount, 0.01)] ?? min;
  const p99 = finiteValues[percentileIndex(finiteCount, 0.99)] ?? max;
  const centralAbs = Math.max(Math.abs(p01), Math.abs(p99), 1e-12);
  const maxAbs = Math.max(Math.abs(min), Math.abs(max));
  return {
    finiteCount,
    max,
    mean: sum / finiteCount,
    min,
    nonFiniteCount,
    outlierDominated: finiteCount >= 3 && maxAbs > 50 * centralAbs,
    p01,
    p99,
    zeroCount,
  };
}

function buildVertexScalarColorsUnchecked(
  fieldVector: DecodedFieldVector,
  vertexCount: number,
  colorMode: Viewport3DVectorColorMode,
  colorPalette: string,
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer {
  const range =
    resolveProvidedScalarRange(scalarRange) ??
    resolveScalarRange(fieldVector, colorMode);
  const colors = new Float32Array(vertexCount * 3);
  const scalarValues = shaderScalarModeSupports(colorMode)
    ? new Float32Array(vertexCount)
    : undefined;
  writeScalarColors(
    fieldVector,
    colors,
    range,
    0,
    fieldVector.pointCount,
    colorMode,
    colorPalette,
    scalarValues,
  );
  return {
    colors,
    colorMode,
    colorPalette,
    quantityId: fieldVector.quantityId,
    range,
    rangeDiagnostics: resolveScalarRangeDiagnostics(fieldVector, colorMode),
    scalarValues,
  };
}

function percentileIndex(count: number, percentile: number): number {
  return Math.min(
    count - 1,
    Math.max(0, Math.floor((count - 1) * percentile)),
  );
}

function writeScalarColors(
  fieldVector: DecodedFieldVector,
  colors: Float32Array,
  range: ScalarRange,
  start: number,
  end: number,
  colorMode: Viewport3DVectorColorMode,
  colorPalette: string,
  scalarValues?: Float32Array,
  vectorValues?: Float32Array,
): void {
  for (let index = start; index < end; index += 1) {
    if (vectorValues) {
      writeVectorValue(fieldVector, index, vectorValues, index);
    }
    if (scalarValues) {
      scalarValues[index] = scalarAt(fieldVector, index, colorMode);
    }
    if (colors.length > 0) {
      const [red, green, blue] = colorAt(
        fieldVector,
        index,
        colorMode,
        range,
        colorPalette,
      );
      const target = index * 3;
      colors[target] = red;
      colors[target + 1] = green;
      colors[target + 2] = blue;
    }
  }
}

function writeVectorValue(
  fieldVector: DecodedFieldVector,
  sourceIndex: number,
  targetValues: Float32Array,
  targetIndex: number,
): void {
  const source = sourceIndex * fieldVector.nComp;
  const target = targetIndex * 3;
  targetValues[target] = fieldVector.values[source] ?? 0;
  targetValues[target + 1] = fieldVector.values[source + 1] ?? 0;
  targetValues[target + 2] = fieldVector.values[source + 2] ?? 0;
}

function colorAt(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  colorMode: Viewport3DVectorColorMode,
  range: Viewport3DScalarColorRange,
  colorPalette = "viridis",
): [number, number, number] {
  const offset = pointIndex * fieldVector.nComp;
  if (fieldVector.nComp === 1) {
    const value = fieldVector.values[offset] ?? 0;
    return resolveViewport3DVectorColorRgb(
      "magnitude",
      value,
      0,
      0,
      range,
      normalizeScalarValue(value, range),
      colorPalette,
    ) ?? [1, 1, 1];
  }

  const x = fieldVector.values[offset] ?? 0;
  const y = fieldVector.values[offset + 1] ?? 0;
  const z = fieldVector.values[offset + 2] ?? 0;
  const scalar = resolveViewport3DVectorColorScalar(colorMode, x, y, z);
  return (
    resolveViewport3DVectorColorRgb(
      colorMode,
      x,
      y,
      z,
      range,
      normalizeScalarValue(scalar, range),
      colorPalette,
    ) ?? [1, 1, 1]
  );
}

function scalarAt(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  colorMode: Viewport3DVectorColorMode,
): number {
  const offset = pointIndex * fieldVector.nComp;
  if (fieldVector.nComp === 1) {
    return fieldVector.values[offset] ?? 0;
  }

  const x = fieldVector.values[offset] ?? 0;
  const y = fieldVector.values[offset + 1] ?? 0;
  const z = fieldVector.values[offset + 2] ?? 0;
  return resolveViewport3DVectorColorScalar(colorMode, x, y, z);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Field transform aborted", "AbortError");
  }
}

function normalizeScalarValue(
  value: number,
  range: Viewport3DScalarColorRange,
): number {
  if (!Number.isFinite(value)) return 0.5;
  const span = Math.max(range.max - range.min, 1e-12);
  return Math.min(Math.max((value - range.min) / span, 0), 1);
}

function shaderScalarModeSupports(mode: Viewport3DVectorColorMode): boolean {
  return mode === "magnitude" || mode === "x" || mode === "y" || mode === "z";
}

function shaderVectorModeSupports(
  mode: Viewport3DVectorColorMode,
  fieldVector: DecodedFieldVector,
): boolean {
  return mode === "orientation" && fieldVector.nComp >= 3;
}
