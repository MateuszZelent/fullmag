import type { DecodedFieldVector } from "@/kernel/api/codecs";

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
): ScalarColorBuffer | null {
  if (
    !fieldVector ||
    fieldVector.pointCount !== vertexCount ||
    fieldVector.pointCount === 0 ||
    fieldTransformNeedsChunking(fieldVector.pointCount, maxSynchronousPoints)
  ) {
    return null;
  }

  return buildVertexScalarColorsUnchecked(fieldVector);
}

export async function buildVertexScalarColorsChunked(
  fieldVector: DecodedFieldVector,
  options: ChunkedFieldTransformOptions = {},
): Promise<ScalarColorBuffer> {
  const chunkSize = Math.max(Math.floor(options.chunkSize ?? 10_000), 1);
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());
  const range = resolveScalarRange(fieldVector);
  const colors = new Float32Array(fieldVector.pointCount * 3);

  for (let start = 0; start < fieldVector.pointCount; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, fieldVector.pointCount);
    writeScalarColors(fieldVector, colors, range, start, end);
    if (end < fieldVector.pointCount) {
      await yieldToMain();
    }
  }

  throwIfAborted(options.signal);
  return { colors, range };
}

export function resolveScalarRange(fieldVector: DecodedFieldVector): ScalarRange {
  let min = Infinity;
  let max = -Infinity;

  for (let index = 0; index < fieldVector.pointCount; index += 1) {
    const value = scalarAt(fieldVector, index);
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
): ScalarColorBuffer {
  const range = resolveScalarRange(fieldVector);
  const colors = new Float32Array(fieldVector.pointCount * 3);
  writeScalarColors(fieldVector, colors, range, 0, fieldVector.pointCount);
  return { colors, range };
}

function writeScalarColors(
  fieldVector: DecodedFieldVector,
  colors: Float32Array,
  range: ScalarRange,
  start: number,
  end: number,
): void {
  const span = Math.max(range.max - range.min, 1e-12);

  for (let index = start; index < end; index += 1) {
    const normalized = Math.min(
      Math.max((scalarAt(fieldVector, index) - range.min) / span, 0),
      1,
    );
    const target = index * 3;
    colors[target] = normalized;
    colors[target + 1] = 0.38 + 0.42 * (1 - Math.abs(normalized - 0.5) * 2);
    colors[target + 2] = 1 - normalized;
  }
}

function scalarAt(fieldVector: DecodedFieldVector, pointIndex: number): number {
  const offset = pointIndex * fieldVector.nComp;
  if (fieldVector.nComp === 1) {
    return fieldVector.values[offset] ?? 0;
  }

  const x = fieldVector.values[offset] ?? 0;
  const y = fieldVector.values[offset + 1] ?? 0;
  const z = fieldVector.values[offset + 2] ?? 0;
  return Math.hypot(x, y, z);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Field transform aborted", "AbortError");
  }
}
