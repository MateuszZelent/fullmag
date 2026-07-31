import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildSurfaceFaceScalarColors,
  buildThicknessAverageZScalarColors,
  buildVertexScalarColorsChunked,
  fieldVectorSupportsScalarColorMode,
  type ChunkedFieldTransformOptions,
  type ScalarColorBuffer,
  type ScalarRange,
} from "../viewport3dFieldMapping";
import {
  normalizeViewport3DVectorColorMode,
  resolveViewport3DVectorColorRgb,
  resolveViewport3DVectorColorScalar,
  type Viewport3DVectorColorMode,
} from "../viewport3dVectorColoring";

export type Viewport3DFieldColorBuildTarget =
  | {
      kind: "full-domain";
      vertexCount: number;
    }
  | {
      kind: "mapped-vertices";
      targetNodeIndices: Uint32Array;
      vertexCount: number;
    }
  | {
      kind: "sampled";
      pointIndices: Uint32Array;
    }
  | {
      kind: "surface-faces";
      surfaceIndices: Uint32Array;
      targetNodeIndices?: Uint32Array | null;
      vertexCount: number;
    }
  | {
      kind: "thickness-average-z";
      positions: Float32Array;
      surfaceIndices: Uint32Array;
      targetNodeIndices?: Uint32Array | null;
      vertexCount: number;
    };

export interface Viewport3DFieldColorBuildModelInput
  extends ChunkedFieldTransformOptions {
  fieldVector: DecodedFieldVector;
  target: Viewport3DFieldColorBuildTarget;
}

export interface Viewport3DFieldColorBuildByteEstimateInput {
  colorMode?: string;
  fieldVector: DecodedFieldVector;
  shaderOnly?: boolean;
  target: Viewport3DFieldColorBuildTarget;
}

export async function buildViewport3DFieldColorBuffer({
  fieldVector,
  target,
  ...options
}: Viewport3DFieldColorBuildModelInput): Promise<ScalarColorBuffer | null> {
  if (fieldVector.pointCount === 0) return null;

  switch (target.kind) {
    case "full-domain":
      if (target.vertexCount < fieldVector.pointCount) return null;
      return buildVertexScalarColorsChunked(fieldVector, options);
    case "mapped-vertices":
      return buildMappedFieldColorBuffer(fieldVector, target, options);
    case "sampled":
      return buildSampledFieldColorBuffer(fieldVector, target, options);
    case "surface-faces":
      return buildSurfaceFaceScalarColors(
        fieldVector,
        target.surfaceIndices,
        target.vertexCount,
        options.colorMode,
        options.colorPalette,
        options.scalarRange,
        Number.POSITIVE_INFINITY,
        target.targetNodeIndices,
      );
    case "thickness-average-z":
      return buildThicknessAverageZScalarColors(
        fieldVector,
        target.positions,
        target.surfaceIndices,
        target.vertexCount,
        options.colorMode,
        options.colorPalette,
        options.scalarRange,
        Number.POSITIVE_INFINITY,
        target.targetNodeIndices,
      );
  }
}

export function estimateViewport3DFieldColorBuildInputBytes({
  fieldVector,
  target,
}: {
  fieldVector: DecodedFieldVector;
  target: Viewport3DFieldColorBuildTarget;
}): number {
  switch (target.kind) {
    case "full-domain":
      return fieldVector.values.byteLength;
    case "mapped-vertices":
      return fieldVector.values.byteLength + target.targetNodeIndices.byteLength;
    case "sampled":
      return fieldVector.values.byteLength + target.pointIndices.byteLength;
    case "surface-faces":
      return (
        fieldVector.values.byteLength +
        target.surfaceIndices.byteLength +
        (target.targetNodeIndices?.byteLength ?? 0)
      );
    case "thickness-average-z":
      return (
        fieldVector.values.byteLength +
        target.positions.byteLength +
        target.surfaceIndices.byteLength +
        (target.targetNodeIndices?.byteLength ?? 0)
      );
  }
}

export function estimateViewport3DFieldColorBuildOutputBytes({
  colorMode,
  fieldVector,
  shaderOnly,
  target,
}: Viewport3DFieldColorBuildByteEstimateInput): number {
  const resolvedColorMode = normalizeViewport3DVectorColorMode(
    colorMode,
    "magnitude",
  );
  const vertexCount = resolveTargetVertexCount(fieldVector, target);
  const shaderVectorMode =
    shaderOnly && shaderVectorModeSupports(resolvedColorMode, fieldVector);
  if (shaderVectorMode) {
    return vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  }
  const colorBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const scalarBytes = shaderScalarModeSupports(resolvedColorMode)
    ? vertexCount * Float32Array.BYTES_PER_ELEMENT
    : 0;
  return colorBytes + scalarBytes;
}

async function buildSampledFieldColorBuffer(
  fieldVector: DecodedFieldVector,
  target: Extract<Viewport3DFieldColorBuildTarget, { kind: "sampled" }>,
  options: ChunkedFieldTransformOptions,
): Promise<ScalarColorBuffer | null> {
  if (target.pointIndices.length === 0) return null;
  const colorMode = normalizeViewport3DVectorColorMode(
    options.colorMode,
    "magnitude",
  );
  if (!fieldVectorSupportsScalarColorMode(fieldVector, colorMode)) return null;
  const colorPalette = options.colorPalette ?? "viridis";
  const shaderOnly = resolveShaderOnly(colorMode, fieldVector, options);
  const range = shaderOnly.vector
    ? { max: 1, min: 0 }
    : await resolveScalarRangeForField(fieldVector, colorMode, options);
  const colors = shaderOnly.any
    ? new Float32Array(0)
    : new Float32Array(target.pointIndices.length * 3);
  const scalarValues = shaderScalarModeSupports(colorMode)
    ? new Float32Array(target.pointIndices.length)
    : undefined;
  const vectorValues = shaderOnly.vector
    ? new Float32Array(target.pointIndices.length * 3)
    : undefined;
  const chunkSize = resolveChunkSize(options);
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());

  for (let start = 0; start < target.pointIndices.length; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, target.pointIndices.length);
    for (let index = start; index < end; index += 1) {
      const pointIndex = target.pointIndices[index] ?? 0;
      if (pointIndex >= fieldVector.pointCount) {
        if (colors.length > 0) writeFallbackGray(colors, index);
        continue;
      }
      writeFieldColor(
        fieldVector,
        pointIndex,
        index,
        colors,
        range,
        colorMode,
        colorPalette,
        scalarValues,
        vectorValues,
      );
    }
    if (end < target.pointIndices.length) {
      await yieldToMain();
    }
  }

  throwIfAborted(options.signal);
  return {
    colors,
    colorMode,
    colorPalette,
    range,
    scalarValues,
    vectorValues,
  };
}

async function buildMappedFieldColorBuffer(
  fieldVector: DecodedFieldVector,
  target: Extract<Viewport3DFieldColorBuildTarget, { kind: "mapped-vertices" }>,
  options: ChunkedFieldTransformOptions,
): Promise<ScalarColorBuffer | null> {
  if (target.targetNodeIndices.length < fieldVector.pointCount) return null;
  const colorMode = normalizeViewport3DVectorColorMode(
    options.colorMode,
    "magnitude",
  );
  if (!fieldVectorSupportsScalarColorMode(fieldVector, colorMode)) return null;
  const colorPalette = options.colorPalette ?? "viridis";
  const shaderOnly = resolveShaderOnly(colorMode, fieldVector, options);
  const range = shaderOnly.vector
    ? { max: 1, min: 0 }
    : await resolveScalarRangeForField(fieldVector, colorMode, options);
  const colors = shaderOnly.any
    ? new Float32Array(0)
    : new Float32Array(target.vertexCount * 3);
  const scalarValues = shaderScalarModeSupports(colorMode)
    ? new Float32Array(target.vertexCount)
    : undefined;
  const vectorValues = shaderOnly.vector
    ? new Float32Array(target.vertexCount * 3)
    : undefined;
  const chunkSize = resolveChunkSize(options);
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());

  for (let start = 0; start < fieldVector.pointCount; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, fieldVector.pointCount);
    for (let fieldIndex = start; fieldIndex < end; fieldIndex += 1) {
      const targetIndex = target.targetNodeIndices[fieldIndex] ?? -1;
      if (targetIndex < 0 || targetIndex >= target.vertexCount) continue;
      writeFieldColor(
        fieldVector,
        fieldIndex,
        targetIndex,
        colors,
        range,
        colorMode,
        colorPalette,
        scalarValues,
        vectorValues,
      );
    }
    if (end < fieldVector.pointCount) {
      await yieldToMain();
    }
  }

  throwIfAborted(options.signal);
  return {
    colors,
    colorMode,
    colorPalette,
    range,
    scalarValues,
    vectorValues,
  };
}

async function resolveScalarRangeForField(
  fieldVector: DecodedFieldVector,
  colorMode: Viewport3DVectorColorMode,
  options: ChunkedFieldTransformOptions,
): Promise<ScalarRange> {
  const providedRange = resolveProvidedScalarRange(options.scalarRange);
  if (providedRange) return providedRange;

  const chunkSize = resolveChunkSize(options);
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());
  let min = Infinity;
  let max = -Infinity;

  for (let start = 0; start < fieldVector.pointCount; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, fieldVector.pointCount);
    for (let index = start; index < end; index += 1) {
      const value = scalarAt(fieldVector, index, colorMode);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (end < fieldVector.pointCount) {
      await yieldToMain();
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { max: 0, min: 0 };
  }
  return { max, min };
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

function resolveTargetVertexCount(
  fieldVector: DecodedFieldVector,
  target: Viewport3DFieldColorBuildTarget,
): number {
  switch (target.kind) {
    case "full-domain":
      return Math.min(target.vertexCount, fieldVector.pointCount);
    case "mapped-vertices":
      return target.vertexCount;
    case "sampled":
      return target.pointIndices.length;
    case "surface-faces":
    case "thickness-average-z":
      return target.surfaceIndices.length;
  }
}

function resolveShaderOnly(
  colorMode: Viewport3DVectorColorMode,
  fieldVector: DecodedFieldVector,
  options: ChunkedFieldTransformOptions,
): { any: boolean; vector: boolean } {
  const scalar = shaderScalarModeSupports(colorMode);
  const vector = shaderVectorModeSupports(colorMode, fieldVector);
  const any = Boolean(options.shaderOnly && (scalar || vector));
  return {
    any,
    vector: Boolean(any && vector),
  };
}

function resolveChunkSize(options: ChunkedFieldTransformOptions): number {
  return Math.max(Math.floor(options.chunkSize ?? 10_000), 1);
}

function writeFieldColor(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  targetIndex: number,
  colors: Float32Array,
  range: ScalarRange,
  colorMode: Viewport3DVectorColorMode,
  colorPalette: string,
  scalarValues?: Float32Array,
  vectorValues?: Float32Array,
): void {
  if (vectorValues) {
    writeVectorValue(fieldVector, pointIndex, vectorValues, targetIndex);
  }
  if (scalarValues) {
    scalarValues[targetIndex] = scalarAt(fieldVector, pointIndex, colorMode);
  }
  if (colors.length > 0) {
    const [red, green, blue] = colorAt(
      fieldVector,
      pointIndex,
      colorMode,
      range,
      colorPalette,
    );
    const target = targetIndex * 3;
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }
}

function writeFallbackGray(colors: Float32Array, targetIndex: number): void {
  const target = targetIndex * 3;
  colors[target] = 0.5;
  colors[target + 1] = 0.5;
  colors[target + 2] = 0.5;
}

function writeVectorValue(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  values: Float32Array,
  targetIndex: number,
): void {
  const source = pointIndex * fieldVector.nComp;
  const target = targetIndex * 3;
  values[target] = fieldVector.values[source] ?? 0;
  values[target + 1] = fieldVector.values[source + 1] ?? 0;
  values[target + 2] = fieldVector.values[source + 2] ?? 0;
}

function colorAt(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  colorMode: Viewport3DVectorColorMode,
  range: ScalarRange,
  colorPalette: string,
): [number, number, number] {
  const offset = pointIndex * fieldVector.nComp;
  if (fieldVector.nComp === 1) {
    const value = fieldVector.values[offset] ?? 0;
    return (
      resolveViewport3DVectorColorRgb(
        "magnitude",
        value,
        0,
        0,
        range,
        normalizeScalarValue(value, range),
        colorPalette,
      ) ?? [1, 1, 1]
    );
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

function normalizeScalarValue(value: number, range: ScalarRange): number {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Field transform aborted", "AbortError");
  }
}
