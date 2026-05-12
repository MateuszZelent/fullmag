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
    // Field may cover a subset of nodes (e.g. magnetic domain only, no airbox).
    // Allow pointCount < vertexCount; reject only when field has MORE points than topology.
    fieldVector.pointCount > vertexCount ||
    fieldVector.pointCount === 0 ||
    resolvedColorMode === "monochrome" ||
    fieldTransformNeedsChunking(fieldVector.pointCount, maxSynchronousPoints)
  ) {
    return null;
  }

  return buildVertexScalarColorsUnchecked(fieldVector, vertexCount, resolvedColorMode);
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
  const range = resolveScalarRange(fieldVector, colorMode);
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
  // Allocate for the full topology vertex count (may be larger than the field
  // point count when the field covers only part of the domain, e.g. magnetic
  // nodes only).  Extra vertices default to 0 (black).
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
