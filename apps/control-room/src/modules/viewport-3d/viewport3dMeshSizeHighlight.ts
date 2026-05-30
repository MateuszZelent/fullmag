import type { DecodedTopology } from "@/kernel/api/codecs";
import type {
  MeshSizeHistogramDistributionId,
  MeshSizeHistogramHighlight,
} from "@/kernel/events/eventTypes";

import type {
  FemManifestRenderDomain,
  Viewport3DMeshPart,
} from "./viewport3dDomainAdapter";
import type {
  Viewport3DRenderablePart,
  Viewport3DTopologyRenderModel,
} from "./viewport3dRenderModel";

export interface Viewport3DMeshSizeHighlightModel {
  edgeIndices: Uint32Array;
  eligibleElementCount: number;
  label: string;
  matchedElementCount: number;
  positions: Float32Array;
  sampledElementCount: number;
}

interface ElementRange {
  end: number;
  start: number;
}

const TETRA_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];
const REGULAR_TETRA_CHARACTERISTIC_FACTOR = 6 * Math.sqrt(2);
const MAX_HIGHLIGHTED_TETRAHEDRA = 20_000;

export function buildViewport3DMeshSizeHighlightModel(
  topology: DecodedTopology | null | undefined,
  topologyModel:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined,
  femDomain: FemManifestRenderDomain,
  highlight: MeshSizeHistogramHighlight | null,
): Viewport3DMeshSizeHighlightModel | null {
  if (!topology || !topologyModel || !highlight) return null;
  if (topology.indices.length !== topology.elementCount * 4) return null;
  const range = normalizeHighlightRange(highlight.lo, highlight.hi);
  if (!range) return null;

  const scope = resolveElementScope(topology, femDomain, highlight);
  if (!scope) return null;

  const matchingElements: number[] = [];
  let eligibleElementCount = 0;
  for (let element = 0; element < topology.elementCount; element += 1) {
    if (!scope.includes(element)) continue;
    eligibleElementCount += 1;
    if (
      elementMatchesDistribution(
        topology,
        element,
        highlight.distributionId,
        range,
      )
    ) {
      matchingElements.push(element);
    }
  }

  if (matchingElements.length === 0) return null;

  const sampledElements = sampleElements(
    matchingElements,
    MAX_HIGHLIGHTED_TETRAHEDRA,
  );
  return {
    edgeIndices: buildElementEdgeIndices(topology, sampledElements),
    eligibleElementCount,
    label: `${highlight.distributionLabel}: ${highlight.binLabel}`,
    matchedElementCount: matchingElements.length,
    positions: topologyModel.positions,
    sampledElementCount: sampledElements.length,
  };
}

function normalizeHighlightRange(
  lo: number | null,
  hi: number | null,
): { hi: number | null; lo: number | null } | null {
  const normalizedLo = typeof lo === "number" && Number.isFinite(lo) ? lo : null;
  const normalizedHi = typeof hi === "number" && Number.isFinite(hi) ? hi : null;
  if (normalizedLo === null && normalizedHi === null) return null;
  if (
    normalizedLo !== null &&
    normalizedHi !== null &&
    normalizedLo > normalizedHi
  ) {
    return { hi: normalizedLo, lo: normalizedHi };
  }
  return { hi: normalizedHi, lo: normalizedLo };
}

function resolveElementScope(
  topology: DecodedTopology,
  femDomain: FemManifestRenderDomain,
  highlight: MeshSizeHistogramHighlight,
): { includes: (element: number) => boolean } | null {
  const scope = highlight.scope;
  if (scope.kind === "all") {
    return { includes: () => true };
  }

  if (scope.kind === "airbox") {
    const ranges = rangesForParts(femDomain.airboxParts, topology.elementCount);
    if (ranges.length > 0) {
      return { includes: (element) => elementInRanges(element, ranges) };
    }
    if (topology.elementMarkers.length === topology.elementCount) {
      return {
        includes: (element) => topology.elementMarkers[element] === 0,
      };
    }
    return null;
  }

  const partIds = femDomain.objectPartIds.get(scope.objectId) ?? [];
  const parts = partIds.flatMap((partId) => {
    const part = femDomain.partsById.get(partId);
    return part ? [part] : [];
  });
  const ranges = rangesForParts(parts, topology.elementCount);
  if (ranges.length === 0) return null;
  return { includes: (element) => elementInRanges(element, ranges) };
}

function rangesForParts(
  parts: readonly Viewport3DMeshPart[],
  elementCount: number,
): ElementRange[] {
  return parts.flatMap((part) => {
    const start = clampElementIndex(part.element_start, elementCount);
    const count = Math.max(Math.floor(part.element_count), 0);
    const end = clampElementIndex(start + count, elementCount);
    return end > start ? [{ end, start }] : [];
  });
}

function clampElementIndex(value: number, elementCount: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), elementCount));
}

function elementInRanges(element: number, ranges: readonly ElementRange[]): boolean {
  for (const range of ranges) {
    if (element >= range.start && element < range.end) return true;
  }
  return false;
}

function elementMatchesDistribution(
  topology: DecodedTopology,
  element: number,
  distributionId: MeshSizeHistogramDistributionId,
  range: { hi: number | null; lo: number | null },
): boolean {
  if (distributionId === "edge_length") {
    return tetraEdgeLengths(topology, element).some((length) =>
      valueInRange(length, range),
    );
  }

  const volume = tetraVolume(topology, element);
  if (!Number.isFinite(volume) || volume <= 0) return false;
  if (distributionId === "volume") {
    return valueInRange(volume, range);
  }

  const characteristicSize = Math.cbrt(
    volume * REGULAR_TETRA_CHARACTERISTIC_FACTOR,
  );
  return valueInRange(characteristicSize, range);
}

function valueInRange(
  value: number,
  range: { hi: number | null; lo: number | null },
): boolean {
  if (!Number.isFinite(value)) return false;
  if (range.lo !== null && value < range.lo) return false;
  if (range.hi !== null && value > range.hi) return false;
  return true;
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

function tetraEdgeLengths(topology: DecodedTopology, element: number): number[] {
  const nodes = tetraNodes(topology, element);
  if (!nodes) return [];
  return TETRA_EDGES.flatMap(([leftCorner, rightCorner]) => {
    const leftNode = nodes[leftCorner];
    const rightNode = nodes[rightCorner];
    return leftNode === undefined || rightNode === undefined
      ? []
      : [nodeDistance(topology.positions, leftNode, rightNode)];
  });
}

function tetraNodes(
  topology: DecodedTopology,
  element: number,
): [number, number, number, number] | null {
  const offset = element * 4;
  const a = topology.indices[offset];
  const b = topology.indices[offset + 1];
  const c = topology.indices[offset + 2];
  const d = topology.indices[offset + 3];
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

function sampleElements(elements: readonly number[], limit: number): number[] {
  if (elements.length <= limit) return [...elements];
  const stride = Math.ceil(elements.length / limit);
  const sampled: number[] = [];
  for (let index = 0; index < elements.length; index += stride) {
    const element = elements[index];
    if (element !== undefined) {
      sampled.push(element);
    }
  }
  return sampled;
}

function buildElementEdgeIndices(
  topology: DecodedTopology,
  elements: readonly number[],
): Uint32Array {
  const edgeKeys = new Set<string>();
  const edgeIndices: number[] = [];
  for (const element of elements) {
    const nodes = tetraNodes(topology, element);
    if (!nodes) continue;
    for (const [leftCorner, rightCorner] of TETRA_EDGES) {
      const leftNode = nodes[leftCorner];
      const rightNode = nodes[rightCorner];
      if (leftNode === undefined || rightNode === undefined) continue;
      pushDedupedEdge(edgeKeys, edgeIndices, leftNode, rightNode);
    }
  }
  return Uint32Array.from(edgeIndices);
}

function pushDedupedEdge(
  edgeKeys: Set<string>,
  edgeIndices: number[],
  leftNode: number,
  rightNode: number,
): void {
  const a = Math.min(leftNode, rightNode);
  const b = Math.max(leftNode, rightNode);
  const key = `${a}:${b}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edgeIndices.push(a, b);
}
