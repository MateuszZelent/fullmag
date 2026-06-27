import type { DecodedFieldVector } from "@/kernel/api/codecs";

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
  quantityId?: string;
  range: ScalarRange;
  rangeDiagnostics?: ScalarRangeDiagnostics;
  scalarValues?: Float32Array;
  targetRevision?: string;
  topologyRevision?: string;
  vectorValues?: Float32Array;
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
