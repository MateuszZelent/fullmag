import type {
  DomainMetaResource,
} from "@/kernel/api/apiTypes";
import type {
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";

export interface Viewport3DNodeSelection {
  nodeCount?: number;
  node_count?: number;
  nodeIndices?: readonly number[];
  node_indices?: readonly number[];
  nodeStart?: number;
  node_start?: number;
}

export interface Viewport3DSurfacePart extends Viewport3DNodeSelection {
  boundary_face_count: number;
  boundary_face_indices?: readonly number[];
  boundary_face_start: number;
  surface_faces?: readonly (readonly number[])[];
}

export interface Viewport3DBounds {
  center: [number, number, number];
  radius: number;
  size: [number, number, number];
}

export function buildTopologyPositions(topology: DecodedTopology): Float32Array {
  return Float32Array.from(topology.positions);
}

export function buildTetraSurfaceIndices(indices: Uint32Array): Uint32Array {
  const tetraCount = Math.floor(indices.length / 4);
  const faces = new Uint32Array(tetraCount * 12);

  for (let tetra = 0; tetra < tetraCount; tetra += 1) {
    const source = tetra * 4;
    const target = tetra * 12;
    const a = indices[source] ?? 0;
    const b = indices[source + 1] ?? 0;
    const c = indices[source + 2] ?? 0;
    const d = indices[source + 3] ?? 0;

    faces.set([a, b, c, a, b, d, a, c, d, b, c, d], target);
  }

  return faces;
}

export function buildPartSurfaceIndices(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  if (part.surface_faces?.length) {
    return flattenSurfaceFaces(part.surface_faces);
  }

  if (part.boundary_face_indices?.length) {
    return surfaceIndicesFromBoundaryFaces(
      topology,
      part.boundary_face_indices,
    );
  }

  if (part.boundary_face_count <= 0) {
    return null;
  }

  return surfaceIndicesFromBoundaryFaceRange(
    topology,
    part.boundary_face_start,
    part.boundary_face_count,
  );
}

export function resolveDomainBounds(
  meta: DomainMetaResource | null | undefined,
): Viewport3DBounds | null {
  const min = meta?.bounds.min;
  const max = meta?.bounds.max;
  if (!min || !max || min.length < 3 || max.length < 3) {
    return null;
  }

  return boundsFromMinMax(
    [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  );
}

export function resolveTopologyBounds(
  topology: DecodedTopology | null | undefined,
): Viewport3DBounds | null {
  if (!topology || topology.positions.length < 3) {
    return null;
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < topology.positions.length; index += 3) {
    const x = topology.positions[index] ?? 0;
    const y = topology.positions[index + 1] ?? 0;
    const z = topology.positions[index + 2] ?? 0;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }

  return boundsFromMinMax(min, max);
}

export function buildVectorLineSegments(
  topology: DecodedTopology | null | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors = 2048,
): Float32Array | null {
  if (
    !topology ||
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    topology.nodeCount === 0
  ) {
    return null;
  }

  const vectorCount = Math.min(
    topology.nodeCount,
    fieldVector.pointCount,
    maxVectors,
  );
  const stride = Math.max(
    1,
    Math.floor(Math.min(topology.nodeCount, fieldVector.pointCount) / vectorCount),
  );
  const segments = new Float32Array(vectorCount * 2 * 3);

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const pointIndex = vector * stride;
    const positionOffset = pointIndex * 3;
    const valueOffset = pointIndex * fieldVector.nComp;
    const target = vector * 6;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz) || 1;

    segments[target] = x;
    segments[target + 1] = y;
    segments[target + 2] = z;
    segments[target + 3] = x + (vx / length) * scale;
    segments[target + 4] = y + (vy / length) * scale;
    segments[target + 5] = z + (vz / length) * scale;
  }

  return segments;
}

export function buildVectorLineSegmentsForNodeSelection(
  topology: DecodedTopology | null | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
  nodeSelection: Viewport3DNodeSelection | null | undefined,
  scale: number,
  maxVectors = 2048,
): Float32Array | null {
  if (
    !topology ||
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    topology.nodeCount === 0
  ) {
    return null;
  }

  const totalSelectedNodes = resolveNodeSelectionCount(nodeSelection, topology);
  if (totalSelectedNodes <= 0) {
    return null;
  }

  const vectorCount = Math.min(totalSelectedNodes, maxVectors);
  const stride = Math.max(1, Math.floor(totalSelectedNodes / vectorCount));
  const segments = new Float32Array(vectorCount * 2 * 3);

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const pointIndex = resolveNodeSelectionIndex(
      nodeSelection,
      vector * stride,
    );
    if (
      pointIndex === null ||
      pointIndex >= topology.nodeCount ||
      pointIndex >= fieldVector.pointCount
    ) {
      continue;
    }

    const positionOffset = pointIndex * 3;
    const valueOffset = pointIndex * fieldVector.nComp;
    const target = vector * 6;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz) || 1;

    segments[target] = x;
    segments[target + 1] = y;
    segments[target + 2] = z;
    segments[target + 3] = x + (vx / length) * scale;
    segments[target + 4] = y + (vy / length) * scale;
    segments[target + 5] = z + (vz / length) * scale;
  }

  return segments;
}

function boundsFromMinMax(
  min: [number, number, number],
  max: [number, number, number],
): Viewport3DBounds {
  const size: [number, number, number] = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];
  const radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12);

  return {
    center: [
      min[0] + size[0] / 2,
      min[1] + size[1] / 2,
      min[2] + size[2] / 2,
    ],
    radius,
    size,
  };
}

function flattenSurfaceFaces(
  surfaceFaces: readonly (readonly number[])[],
): Uint32Array {
  const indices = new Uint32Array(surfaceFaces.length * 3);

  for (let faceIndex = 0; faceIndex < surfaceFaces.length; faceIndex += 1) {
    const face = surfaceFaces[faceIndex];
    const offset = faceIndex * 3;
    indices[offset] = face?.[0] ?? 0;
    indices[offset + 1] = face?.[1] ?? 0;
    indices[offset + 2] = face?.[2] ?? 0;
  }

  return indices;
}

function surfaceIndicesFromBoundaryFaces(
  topology: DecodedTopology,
  faceIndices: readonly number[],
): Uint32Array | null {
  if (!faceIndices.length) return null;

  const indices = new Uint32Array(faceIndices.length * 3);

  for (let index = 0; index < faceIndices.length; index += 1) {
    const faceIndex = faceIndices[index] ?? 0;
    const sourceOffset = faceIndex * 3;
    const targetOffset = index * 3;
    indices[targetOffset] = topology.boundaryFaces[sourceOffset] ?? 0;
    indices[targetOffset + 1] = topology.boundaryFaces[sourceOffset + 1] ?? 0;
    indices[targetOffset + 2] = topology.boundaryFaces[sourceOffset + 2] ?? 0;
  }

  return indices;
}

function surfaceIndicesFromBoundaryFaceRange(
  topology: DecodedTopology,
  start: number,
  count: number,
): Uint32Array | null {
  const safeStart = Math.max(0, Math.floor(start));
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return null;

  const source = topology.boundaryFaces.slice(
    safeStart * 3,
    (safeStart + safeCount) * 3,
  );
  return source.length ? new Uint32Array(source) : null;
}

function resolveNodeSelectionCount(
  selection: Viewport3DNodeSelection | null | undefined,
  topology: DecodedTopology,
): number {
  if (selection?.nodeIndices?.length) {
    return selection.nodeIndices.length;
  }
  if (selection?.node_indices?.length) {
    return selection.node_indices.length;
  }

  return Math.min(
    selection?.nodeCount ?? selection?.node_count ?? topology.nodeCount,
    topology.nodeCount,
  );
}

function resolveNodeSelectionIndex(
  selection: Viewport3DNodeSelection | null | undefined,
  offset: number,
): number | null {
  if (selection?.nodeIndices?.length) {
    return selection.nodeIndices[offset] ?? null;
  }
  if (selection?.node_indices?.length) {
    return selection.node_indices[offset] ?? null;
  }

  return (selection?.nodeStart ?? selection?.node_start ?? 0) + offset;
}
