import type { DecodedMeshQualityData, DecodedTopology } from "@/kernel/api/codecs";

import type {
  MeshQualityHistogramBin,
  MeshQualityMetric,
  MeshQualityStatistics,
  MeshSizeDistribution,
  MeshWorstElement,
} from "./qualityStatistics";

const HISTOGRAM_BIN_COUNT = 30;
const REGULAR_TETRA_CHARACTERISTIC_FACTOR = 6 * Math.sqrt(2);
const CELL_NODE_COUNTS: Readonly<Record<number, number>> = {
  1: 4,
  2: 6,
  3: 5,
  4: 8,
};
const CELL_EDGES: Readonly<
  Record<number, readonly (readonly [number, number])[]>
> = {
  1: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
  2: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]],
  3: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]],
  4: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
};

export function buildScopedMeshQualityStatistics({
  elementIndices,
  meshName,
  quality,
  scopeLabel,
  topology,
}: {
  elementIndices: readonly number[] | null | undefined;
  meshName: string | null;
  quality: DecodedMeshQualityData | null | undefined;
  scopeLabel: string;
  topology: DecodedTopology | null | undefined;
}): MeshQualityStatistics | null {
  if (!topology || !quality || !elementIndices?.length) return null;
  const elements = normalizeElementIndices(
    elementIndices,
    Math.min(topology.elementCount, quality.elementCount),
  );
  if (elements.length === 0) return null;

  const volumeByElement = new Map<number, number>();
  for (const element of elements) {
    const value = quality.volume?.[element] ?? tetraVolume(topology, element);
    if (finitePositive(value)) volumeByElement.set(element, value);
  }
  const volumes = elements.flatMap((element) => {
    const volume = volumeByElement.get(element);
    return volume === undefined ? [] : [volume];
  });
  const edgeLengths = elements.flatMap((element) =>
    cellEdgeLengths(topology, element),
  );
  const allTet4 = elements.every(
    (element) => topologyCell(topology, element)?.type === 1,
  );
  const tetraSizes = allTet4
    ? volumes.map((volume) =>
        Math.cbrt(volume * REGULAR_TETRA_CHARACTERISTIC_FACTOR),
      )
    : [];
  const gammaMetric = buildMetric("gamma", "Gamma", quality.gamma, elements, 0.08);
  const sicnMetric = buildMetric("sicn", "SICN", quality.sicn, elements, 0.1);
  const worstElements = buildWorstElements({
    elements,
    gamma: quality.gamma,
    scopeLabel,
    sicn: quality.sicn,
    topology,
    volumeByElement,
  });

  return {
    edgeLength: summarize(edgeLengths),
    elementCount: elements.length,
    meshName,
    metrics: [sicnMetric, gammaMetric].filter(
      (metric): metric is MeshQualityMetric => metric !== null,
    ),
    qualitySource: "shared-domain per-element quality",
    sizeDistributions: [
      allTet4
        ? buildDistribution("tetra_size", "Tetra size", tetraSizes)
        : null,
      buildDistribution("edge_length", "Edge length", edgeLengths),
      buildDistribution("volume", "Element volume", volumes),
    ].filter(
      (distribution): distribution is MeshSizeDistribution =>
        distribution !== null,
    ),
    volumeRatio: ratio(volumes),
    warnings: allTet4
      ? []
      : [
          "Tetra size and centroid diagnostics are unavailable for mixed-cell topology; family-aware edge lengths and published element volumes remain available.",
        ],
    worstElements,
    worstElementsByMetric: {
      gamma: buildWorstElements({
        elements,
        gamma: quality.gamma,
        metric: "gamma",
        scopeLabel,
        sicn: quality.sicn,
        topology,
        volumeByElement,
      }),
      sicn: buildWorstElements({
        elements,
        gamma: quality.gamma,
        metric: "sicn",
        scopeLabel,
        sicn: quality.sicn,
        topology,
        volumeByElement,
      }),
    },
  };
}

function normalizeElementIndices(
  elementIndices: readonly number[],
  elementCount: number,
): number[] {
  const unique = new Set<number>();
  for (const value of elementIndices) {
    if (!Number.isFinite(value)) continue;
    const element = Math.floor(value);
    if (element >= 0 && element < elementCount) unique.add(element);
  }
  return Array.from(unique).sort((left, right) => left - right);
}

function buildMetric(
  id: MeshQualityMetric["id"],
  label: string,
  values: Float64Array | null | undefined,
  elements: readonly number[],
  threshold: number,
): MeshQualityMetric | null {
  if (!values) return null;
  const samples = elements.flatMap((element) => {
    const value = values[element];
    return finite(value) ? [value] : [];
  });
  if (samples.length === 0) return null;
  const belowThresholdCount = samples.filter((value) => value < threshold).length;
  return {
    belowThresholdCount,
    belowThresholdFraction: belowThresholdCount / samples.length,
    histogram: histogram(samples, HISTOGRAM_BIN_COUNT),
    id,
    label,
    max: max(samples),
    mean: mean(samples),
    min: min(samples),
    p05: percentile(samples, 0.05),
    threshold,
  };
}

function buildDistribution(
  id: MeshSizeDistribution["id"],
  label: string,
  values: readonly number[],
): MeshSizeDistribution | null {
  if (values.length === 0) return null;
  return {
    histogram: histogram(values, HISTOGRAM_BIN_COUNT),
    id,
    label,
    max: max(values),
    mean: mean(values),
    min: min(values),
    ratio: ratio(values),
    std: std(values),
  };
}

function histogram(
  values: readonly number[],
  binCount: number,
): MeshQualityHistogramBin[] {
  const finiteValues = values.filter(finite);
  if (finiteValues.length === 0) return [];
  const lo = min(finiteValues);
  const hi = max(finiteValues);
  if (lo === null || hi === null) return [];
  if (lo === hi) {
    return [{
      count: finiteValues.length,
      fraction: 1,
      hi,
      label: formatBinLabel(lo, hi),
      lo,
    }];
  }
  const counts = Array.from({ length: binCount }, () => 0);
  const width = (hi - lo) / binCount;
  for (const value of finiteValues) {
    const index =
      value === hi
        ? binCount - 1
        : Math.max(0, Math.min(binCount - 1, Math.floor((value - lo) / width)));
    counts[index] += 1;
  }
  const maxCount = Math.max(...counts, 0);
  return counts.map((count, index) => {
    const binLo = lo + width * index;
    const binHi = index === binCount - 1 ? hi : lo + width * (index + 1);
    return {
      count,
      fraction: maxCount > 0 ? count / maxCount : 0,
      hi: binHi,
      label: formatBinLabel(binLo, binHi),
      lo: binLo,
    };
  });
}

function buildWorstElements({
  elements,
  gamma,
  metric = "gamma",
  scopeLabel,
  sicn,
  topology,
  volumeByElement,
}: {
  elements: readonly number[];
  gamma: Float64Array | null | undefined;
  metric?: MeshQualityMetric["id"];
  scopeLabel: string;
  sicn: Float64Array | null | undefined;
  topology: DecodedTopology;
  volumeByElement: ReadonlyMap<number, number>;
}): MeshWorstElement[] {
  const ranked = elements
    .flatMap((element) => {
      const score = metric === "sicn" ? sicn?.[element] : gamma?.[element];
      return finite(score)
        ? [
            {
              element,
              gamma: gamma?.[element] ?? null,
              score,
              sicn: sicn?.[element] ?? null,
            },
          ]
        : [];
    })
    .sort((left, right) => (left.score ?? 0) - (right.score ?? 0))
    .slice(0, 10);
  return ranked.map((entry) => ({
    centroid: tetraCentroid(topology, entry.element),
    elementIndex: entry.element,
    gamma: finite(entry.gamma) ? entry.gamma : null,
    scopeLabel,
    sicn: finite(entry.sicn) ? entry.sicn : null,
    volume: volumeByElement.get(entry.element) ?? null,
  }));
}

function tetraVolume(topology: DecodedTopology, element: number): number {
  const nodes = tetraNodes(topology, element);
  if (!nodes) return Number.NaN;
  const positions = topology.positions;
  const ax = positions[nodes[0] * 3] ?? 0;
  const ay = positions[nodes[0] * 3 + 1] ?? 0;
  const az = positions[nodes[0] * 3 + 2] ?? 0;
  const bx = (positions[nodes[1] * 3] ?? 0) - ax;
  const by = (positions[nodes[1] * 3 + 1] ?? 0) - ay;
  const bz = (positions[nodes[1] * 3 + 2] ?? 0) - az;
  const cx = (positions[nodes[2] * 3] ?? 0) - ax;
  const cy = (positions[nodes[2] * 3 + 1] ?? 0) - ay;
  const cz = (positions[nodes[2] * 3 + 2] ?? 0) - az;
  const dx = (positions[nodes[3] * 3] ?? 0) - ax;
  const dy = (positions[nodes[3] * 3 + 1] ?? 0) - ay;
  const dz = (positions[nodes[3] * 3 + 2] ?? 0) - az;
  const crossX = by * cz - bz * cy;
  const crossY = bz * cx - bx * cz;
  const crossZ = bx * cy - by * cx;
  return Math.abs(crossX * dx + crossY * dy + crossZ * dz) / 6;
}

function cellEdgeLengths(topology: DecodedTopology, element: number): number[] {
  const cell = topologyCell(topology, element);
  if (!cell) return [];
  return (CELL_EDGES[cell.type] ?? []).flatMap(([leftCorner, rightCorner]) => {
    const nodes = cell.nodes;
    const leftNode = nodes[leftCorner];
    const rightNode = nodes[rightCorner];
    return leftNode === undefined || rightNode === undefined
      ? []
      : [nodeDistance(topology.positions, leftNode, rightNode)];
  });
}

function tetraCentroid(
  topology: DecodedTopology,
  element: number,
): [number, number, number] | null {
  const nodes = tetraNodes(topology, element);
  if (!nodes) return null;
  const positions = topology.positions;
  return [
    nodes.reduce((sum, node) => sum + (positions[node * 3] ?? 0), 0) / 4,
    nodes.reduce((sum, node) => sum + (positions[node * 3 + 1] ?? 0), 0) / 4,
    nodes.reduce((sum, node) => sum + (positions[node * 3 + 2] ?? 0), 0) / 4,
  ];
}

function tetraNodes(
  topology: DecodedTopology,
  element: number,
): [number, number, number, number] | null {
  const cell = topologyCell(topology, element);
  if (!cell || cell.type !== 1) return null;
  const [a, b, c, d] = cell.nodes;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    a >= topology.nodeCount ||
    b >= topology.nodeCount ||
    c >= topology.nodeCount ||
    d >= topology.nodeCount
  ) {
    return null;
  }
  return [a, b, c, d];
}

function topologyCell(
  topology: DecodedTopology,
  element: number,
): { nodes: readonly number[]; type: number } | null {
  if (!Number.isInteger(element) || element < 0) return null;
  if (
    topology.cellTypes &&
    topology.cellOffsets &&
    topology.cellNodes &&
    topology.cellOffsets.length === topology.cellTypes.length + 1 &&
    element < topology.cellTypes.length
  ) {
    const type = topology.cellTypes[element] ?? 0;
    const start = topology.cellOffsets[element] ?? 0;
    const end = topology.cellOffsets[element + 1] ?? start;
    const nodes = Array.from(topology.cellNodes.subarray(start, end));
    if (
      nodes.length !== CELL_NODE_COUNTS[type] ||
      nodes.some((node) => node >= topology.nodeCount)
    ) {
      return null;
    }
    return { nodes, type };
  }
  const offset = element * 4;
  const nodes = Array.from(topology.indices.subarray(offset, offset + 4));
  if (nodes.length !== 4 || nodes.some((node) => node >= topology.nodeCount)) {
    return null;
  }
  return { nodes, type: 1 };
}

function nodeDistance(
  positions: ArrayLike<number>,
  leftNode: number,
  rightNode: number,
): number {
  const leftOffset = leftNode * 3;
  const rightOffset = rightNode * 3;
  return Math.hypot(
    (positions[rightOffset] ?? 0) - (positions[leftOffset] ?? 0),
    (positions[rightOffset + 1] ?? 0) - (positions[leftOffset + 1] ?? 0),
    (positions[rightOffset + 2] ?? 0) - (positions[leftOffset + 2] ?? 0),
  );
}

function summarize(values: readonly number[]): MeshQualityStatistics["edgeLength"] {
  if (values.length === 0) return null;
  return {
    max: max(values),
    mean: mean(values),
    min: min(values),
    std: std(values),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function min(values: readonly number[]): number | null {
  return values.length ? Math.min(...values) : null;
}

function max(values: readonly number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: readonly number[]): number | null {
  const avg = mean(values);
  if (avg === null || values.length === 0) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function ratio(values: readonly number[]): number | null {
  const low = min(values);
  const high = max(values);
  if (low === null || high === null || low <= 0) return null;
  return high / low;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)),
  );
  return sorted[index] ?? null;
}

function formatBinNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0 && (abs < 1e-3 || abs >= 1e4)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

function formatBinLabel(lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return "unbounded";
  return `${formatBinNumber(lo)} to ${formatBinNumber(hi)}`;
}
