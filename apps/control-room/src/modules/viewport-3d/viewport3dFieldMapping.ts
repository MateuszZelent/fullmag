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

export interface ScalarColorBuffer {
  colors: Float32Array;
  range: ScalarRange;
}

export interface ChunkedFieldTransformOptions {
  chunkSize?: number;
  colorMode?: string;
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
): ScalarColorBuffer | null {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  if (
    !fieldVector ||
    fieldVector.pointCount > vertexCount ||
    fieldVector.pointCount === 0 ||
    resolvedColorMode === "monochrome" ||
    fieldTransformNeedsChunking(fieldVector.pointCount, maxSynchronousPoints)
  ) {
    return null;
  }

  return buildVertexScalarColorsUnchecked(fieldVector, vertexCount, resolvedColorMode);
}

export function buildSampledScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  pointIndices: Uint32Array | null | undefined,
  colorMode = "magnitude",
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
    resolvedColorMode === "monochrome"
  ) {
    return null;
  }

  const range = resolveScalarRange(fieldVector, resolvedColorMode);
  const colors = new Float32Array(pointIndices.length * 3);

  for (let index = 0; index < pointIndices.length; index += 1) {
    const pointIndex = pointIndices[index] ?? 0;
    if (pointIndex >= fieldVector.pointCount) {
      return null;
    }
    const [red, green, blue] = colorAt(
      fieldVector,
      pointIndex,
      resolvedColorMode,
      range,
    );
    const target = index * 3;
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }

  return { colors, range };
}

export async function buildVertexScalarColorsChunked(
  fieldVector: DecodedFieldVector,
  options: ChunkedFieldTransformOptions = {},
): Promise<ScalarColorBuffer> {
  const chunkSize = Math.max(Math.floor(options.chunkSize ?? 10_000), 1);
  const colorMode = normalizeViewport3DVectorColorMode(
    options.colorMode,
    "magnitude",
  );
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());
  const range = await resolveScalarRangeChunked(
    fieldVector,
    colorMode,
    chunkSize,
    options.signal,
    yieldToMain,
  );
  const colors = new Float32Array(fieldVector.pointCount * 3);

  for (let start = 0; start < fieldVector.pointCount; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, fieldVector.pointCount);
    writeScalarColors(fieldVector, colors, range, start, end, colorMode);
    if (end < fieldVector.pointCount) {
      await yieldToMain();
    }
  }

  throwIfAborted(options.signal);
  return { colors, range };
}

/**
 * Chunked version of resolveScalarRange that yields to main thread between
 * chunks.  Prevents the synchronous O(N) range scan from blocking the UI
 * for large meshes (> 50K points).
 */
export async function resolveScalarRangeChunked(
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

function buildVertexScalarColorsUnchecked(
  fieldVector: DecodedFieldVector,
  vertexCount: number,
  colorMode: Viewport3DVectorColorMode,
): ScalarColorBuffer {
  const range = resolveScalarRange(fieldVector, colorMode);
  const colors = new Float32Array(vertexCount * 3);
  writeScalarColors(
    fieldVector,
    colors,
    range,
    0,
    fieldVector.pointCount,
    colorMode,
  );
  return { colors, range };
}

function writeScalarColors(
  fieldVector: DecodedFieldVector,
  colors: Float32Array,
  range: ScalarRange,
  start: number,
  end: number,
  colorMode: Viewport3DVectorColorMode,
): void {
  for (let index = start; index < end; index += 1) {
    const [red, green, blue] = colorAt(fieldVector, index, colorMode, range);
    const target = index * 3;
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }
}

function colorAt(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  colorMode: Viewport3DVectorColorMode,
  range: Viewport3DScalarColorRange,
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
  const span = Math.max(range.max - range.min, 1e-12);
  return Math.min(Math.max((value - range.min) / span, 0), 1);
}
