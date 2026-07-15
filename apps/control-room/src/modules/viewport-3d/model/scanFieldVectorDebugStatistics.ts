import type {
  VisualizationDebugIssue,
  VisualizationDebugNumericStats,
  VisualizationDebugSample,
} from "@/kernel/visualization/visualizationDebugTypes";

const MAX_SAMPLES = 12;
const MAX_COMPONENTS = 8;
const SCAN_CHUNK_SIZE = 65_536;

export function selectFieldVectorDebugSampleIndices(pointCount: number): readonly number[] {
  const count = Math.max(0, Math.floor(pointCount));
  if (count <= MAX_SAMPLES) return Object.freeze(Array.from({ length: count }, (_, index) => index));
  const selected = new Set<number>([0, Math.floor((count - 1) / 2), count - 1]);
  for (let slot = 0; selected.size < MAX_SAMPLES && slot < MAX_SAMPLES; slot += 1) {
    selected.add(Math.round((slot * (count - 1)) / (MAX_SAMPLES - 1)));
  }
  return Object.freeze([...selected].sort((left, right) => left - right).slice(0, MAX_SAMPLES));
}

export function buildFieldVectorDebugSamples({
  nComp,
  nodeIndices,
  pointCount,
  values,
}: {
  nComp: number;
  nodeIndices?: readonly number[] | Uint32Array | null;
  pointCount: number;
  values: Float64Array;
}): { issues: readonly VisualizationDebugIssue[]; samples: readonly VisualizationDebugSample[] } {
  const shownComponents = Math.min(Math.max(0, nComp), MAX_COMPONENTS);
  const samples = selectFieldVectorDebugSampleIndices(pointCount).map((pointIndex) => {
    const componentValues: (number | null)[] = [];
    let magnitudeSquared = 0;
    let allFinite = nComp <= MAX_COMPONENTS;
    for (let component = 0; component < shownComponents; component += 1) {
      const value = values[pointIndex * nComp + component] ?? Number.NaN;
      if (Number.isFinite(value)) {
        componentValues.push(value);
        magnitudeSquared += value * value;
      } else {
        componentValues.push(null);
        allFinite = false;
      }
    }
    return Object.freeze({
      componentValues: Object.freeze(componentValues),
      magnitude: allFinite ? Math.sqrt(magnitudeSquared) : null,
      nodeIndex: normalizeNodeIndex(nodeIndices?.[pointIndex]),
      pointIndex,
    });
  });
  const issues: VisualizationDebugIssue[] = nComp > MAX_COMPONENTS
    ? [Object.freeze({ code: "component-display-cap", evidence: Object.freeze([`nComp=${nComp}`, `shown=${MAX_COMPONENTS}`]), message: "Only the first eight components are displayed.", severity: "info", source: "ui-derived" })]
    : [];
  return Object.freeze({ issues: Object.freeze(issues), samples: Object.freeze(samples) });
}

function normalizeNodeIndex(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export async function scanFieldVectorDebugStatistics(
  values: Float64Array,
  options: { signal?: AbortSignal; yieldToMain?: () => Promise<void> } = {},
): Promise<VisualizationDebugNumericStats> {
  let finiteCount = 0;
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let nonFiniteCount = 0;
  let sum = 0;
  let zeroCount = 0;
  const yieldToMain = options.yieldToMain ?? (() => Promise.resolve());
  throwIfAborted(options.signal);
  for (let start = 0; start < values.length; start += SCAN_CHUNK_SIZE) {
    const end = Math.min(start + SCAN_CHUNK_SIZE, values.length);
    for (let index = start; index < end; index += 1) {
      const value = values[index]!;
      if (!Number.isFinite(value)) { nonFiniteCount += 1; continue; }
      finiteCount += 1;
      sum += value;
      if (value === 0) zeroCount += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (end < values.length) {
      await yieldToMain();
      throwIfAborted(options.signal);
    }
  }
  return Object.freeze({
    finiteCount,
    max: finiteCount ? max : null,
    mean: finiteCount ? sum / finiteCount : null,
    min: finiteCount ? min : null,
    nonFiniteCount,
    p01: null,
    p99: null,
    source: "decoded-payload",
    zeroCount,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The debug scan was aborted.", "AbortError");
}
