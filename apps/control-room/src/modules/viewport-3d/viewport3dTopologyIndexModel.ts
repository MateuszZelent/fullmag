import type { DecodedTopology } from "@/kernel/api/codecs";

export interface Viewport3DTopologySurfacePartInput {
  boundary_face_count: number;
  boundary_face_indices?: readonly number[];
  boundary_face_start: number;
  element_count?: number;
  element_start?: number;
  node_count?: number;
  node_indices?: readonly number[];
  node_start?: number;
  nodeCount?: number;
  surface_faces?: readonly (readonly number[])[];
}

export interface Viewport3DTopologyIndexPartInput
  extends Viewport3DTopologySurfacePartInput {
  id: string;
}

export interface Viewport3DPreparedPartTopologyIndices {
  edgeIndices: Uint32Array | null;
  surfaceIndices: Uint32Array | null;
  surfaceNodeIndices: Uint32Array | null;
  surfaceNodeSelection: { nodeIndices: number[] } | null;
  volumeEdgeIndices: Uint32Array | null;
}

export interface Viewport3DTopologyIndexBundle {
  airboxPartsById: Map<string, Viewport3DPreparedPartTopologyIndices>;
  fallbackSurfaceEdgeIndices: Uint32Array | null;
  fallbackSurfaceIndices: Uint32Array;
  fallbackSurfaceNodeIndices: Uint32Array;
  fallbackVolumeEdgeIndices: Uint32Array;
  magneticPartsById: Map<string, Viewport3DPreparedPartTopologyIndices>;
}

export function buildViewport3DTopologyIndexBundle({
  airboxParts,
  magneticParts,
  magneticSurfacePartsByPartId,
  topology,
}: {
  airboxParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticSurfacePartsByPartId?: ReadonlyMap<
    string,
    readonly Viewport3DTopologyIndexPartInput[]
  >;
  topology: Pick<DecodedTopology, "boundaryFaces" | "indices" | "nodeCount">;
}): Viewport3DTopologyIndexBundle {
  const fallbackSurfaceIndices = buildTetraSurfaceIndices(topology.indices);
  const fallbackSurfaceEdgeIndices =
    buildSurfaceEdgeIndices(fallbackSurfaceIndices);
  const fallbackSurfaceNodeIndices = uniqueSortedIndices(fallbackSurfaceIndices);
  const fallbackVolumeEdgeIndices = buildTetraVolumeEdgeIndices(topology.indices);
  const airboxVolumeEdgeFallback =
    airboxParts.length > 0
      ? buildUnclaimedVolumeEdgeIndices(topology, magneticParts) ??
        fallbackVolumeEdgeIndices
      : null;
  const magneticPartsById = new Map<
    string,
    Viewport3DPreparedPartTopologyIndices
  >();
  const airboxPartsById = new Map<
    string,
    Viewport3DPreparedPartTopologyIndices
  >();

  for (const part of magneticParts) {
    magneticPartsById.set(
      part.id,
      buildPreparedPartTopologyIndices({
        part,
        supplementalSurfaceParts:
          magneticSurfacePartsByPartId?.get(part.id) ?? [],
        topology,
      }),
    );
  }

  for (const part of airboxParts) {
    airboxPartsById.set(
      part.id,
      buildPreparedPartTopologyIndices({
        fallbackVolumeEdgeIndices: airboxVolumeEdgeFallback,
        part,
        topology,
      }),
    );
  }

  return {
    airboxPartsById,
    fallbackSurfaceEdgeIndices,
    fallbackSurfaceIndices,
    fallbackSurfaceNodeIndices,
    fallbackVolumeEdgeIndices,
    magneticPartsById,
  };
}

function buildPreparedPartTopologyIndices({
  fallbackVolumeEdgeIndices = null,
  part,
  supplementalSurfaceParts = [],
  topology,
}: {
  fallbackVolumeEdgeIndices?: Uint32Array | null;
  part: Viewport3DTopologyIndexPartInput;
  supplementalSurfaceParts?: readonly Viewport3DTopologyIndexPartInput[];
  topology: Pick<DecodedTopology, "boundaryFaces" | "indices" | "nodeCount">;
}): Viewport3DPreparedPartTopologyIndices {
  const surfaceIndices = buildPartSurfaceIndicesWithSupplemental(
    part,
    topology,
    supplementalSurfaceParts,
  );
  const surfaceNodeIndices = surfaceIndices
    ? uniqueSortedIndices(surfaceIndices)
    : null;
  return {
    edgeIndices: buildSurfaceEdgeIndices(surfaceIndices),
    surfaceIndices,
    surfaceNodeIndices,
    surfaceNodeSelection: surfaceNodeIndices
      ? { nodeIndices: Array.from(surfaceNodeIndices) }
      : null,
    volumeEdgeIndices:
      buildPartVolumeEdgeIndices(part, topology) ?? fallbackVolumeEdgeIndices,
  };
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

export function buildTetraVolumeEdgeIndices(indices: Uint32Array): Uint32Array {
  const tetraCount = Math.floor(indices.length / 4);
  const edges: number[] = [];
  const numericKeyBase = resolveNumericEdgeKeyBase(indices);

  if (numericKeyBase !== null) {
    const seen = new Set<number>();
    for (let tetra = 0; tetra < tetraCount; tetra += 1) {
      const source = tetra * 4;
      const a = indices[source] ?? 0;
      const b = indices[source + 1] ?? 0;
      const c = indices[source + 2] ?? 0;
      const d = indices[source + 3] ?? 0;

      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, a, b);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, a, c);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, a, d);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, b, c);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, b, d);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, c, d);
    }

    return new Uint32Array(edges);
  }

  const seen = new Set<string>();

  for (let tetra = 0; tetra < tetraCount; tetra += 1) {
    const source = tetra * 4;
    const a = indices[source] ?? 0;
    const b = indices[source + 1] ?? 0;
    const c = indices[source + 2] ?? 0;
    const d = indices[source + 3] ?? 0;

    appendTetraEdgeByStringKey(edges, seen, a, b);
    appendTetraEdgeByStringKey(edges, seen, a, c);
    appendTetraEdgeByStringKey(edges, seen, a, d);
    appendTetraEdgeByStringKey(edges, seen, b, c);
    appendTetraEdgeByStringKey(edges, seen, b, d);
    appendTetraEdgeByStringKey(edges, seen, c, d);
  }

  return new Uint32Array(edges);
}

export function buildPartSurfaceIndices(
  part: Viewport3DTopologySurfacePartInput,
  topology: Pick<DecodedTopology, "boundaryFaces" | "nodeCount">,
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

export function buildPartSurfaceIndicesWithSupplemental(
  part: Viewport3DTopologySurfacePartInput,
  topology: Pick<DecodedTopology, "boundaryFaces" | "nodeCount">,
  supplementalSurfaceParts: readonly Viewport3DTopologySurfacePartInput[],
): Uint32Array | null {
  const primarySurfaceIndices = buildPartSurfaceIndices(part, topology);
  if (supplementalSurfaceParts.length === 0) return primarySurfaceIndices;

  const surfaceIndexBuffers: Uint32Array[] = [];
  if (primarySurfaceIndices?.length) {
    surfaceIndexBuffers.push(primarySurfaceIndices);
  }
  for (const supplementalPart of supplementalSurfaceParts) {
    const supplementalSurfaceIndices = buildPartSurfaceIndices(
      supplementalPart,
      topology,
    );
    if (supplementalSurfaceIndices?.length) {
      surfaceIndexBuffers.push(supplementalSurfaceIndices);
    }
  }

  return mergeSurfaceIndexBuffers(surfaceIndexBuffers, topology.nodeCount);
}

export function buildPartVolumeEdgeIndices(
  part: Viewport3DTopologySurfacePartInput,
  topology: Pick<DecodedTopology, "indices" | "nodeCount">,
): Uint32Array | null {
  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  if (elementCount > 0) {
    const indexStart = elementStart * 4;
    const indexEnd = Math.min(
      topology.indices.length,
      indexStart + elementCount * 4,
    );
    if (indexStart < topology.indices.length && indexEnd > indexStart) {
      return buildTetraVolumeEdgeIndices(
        topology.indices.subarray(indexStart, indexEnd),
      );
    }
  }

  return buildPartVolumeEdgeIndicesFromNodes(part, topology);
}

export function buildSurfaceEdgeIndices(
  surfaceIndices: ArrayLike<number> | null | undefined,
): Uint32Array | null {
  if (!surfaceIndices || surfaceIndices.length < 3 || surfaceIndices.length % 3 !== 0) {
    return null;
  }

  const seen = new Set<string>();
  const maxEdges = surfaceIndices.length;
  const edges = new Uint32Array(maxEdges * 2);
  let edgeCount = 0;

  for (let index = 0; index < surfaceIndices.length; index += 3) {
    const a = surfaceIndices[index];
    const b = surfaceIndices[index + 1];
    const c = surfaceIndices[index + 2];
    if (!isValidIndex(a) || !isValidIndex(b) || !isValidIndex(c)) {
      return null;
    }

    edgeCount = appendSurfaceEdge(edges, seen, edgeCount, a, b);
    edgeCount = appendSurfaceEdge(edges, seen, edgeCount, b, c);
    edgeCount = appendSurfaceEdge(edges, seen, edgeCount, c, a);
  }

  return edgeCount > 0 ? edges.slice(0, edgeCount) : null;
}

export function buildUnclaimedVolumeEdgeIndices(
  topology: Pick<DecodedTopology, "indices" | "nodeCount">,
  claimedParts: readonly Viewport3DTopologySurfacePartInput[],
): Uint32Array | null {
  if (topology.indices.length < 4) return null;
  if (claimedParts.length === 0) {
    return buildTetraVolumeEdgeIndices(topology.indices);
  }

  const claims: PartElementClaim[] = [];
  for (const part of claimedParts) {
    const claim = buildPartElementClaim(part, topology);
    if (claim) {
      claims.push(claim);
    }
  }
  if (claims.length === 0) return null;

  const selectedTetraIndices: number[] = [];
  let claimedElementCount = 0;
  for (
    let elementIndex = 0, source = 0;
    source + 3 < topology.indices.length;
    elementIndex += 1, source += 4
  ) {
    const a = topology.indices[source] ?? 0;
    const b = topology.indices[source + 1] ?? 0;
    const c = topology.indices[source + 2] ?? 0;
    const d = topology.indices[source + 3] ?? 0;
    if (isElementClaimed(elementIndex, a, b, c, d, claims)) {
      claimedElementCount += 1;
      continue;
    }
    selectedTetraIndices.push(a, b, c, d);
  }

  if (claimedElementCount === 0) return null;

  return selectedTetraIndices.length
    ? buildTetraVolumeEdgeIndices(new Uint32Array(selectedTetraIndices))
    : null;
}

export function uniqueSortedIndices(indices: Uint32Array): Uint32Array {
  const unique = new Set<number>();
  for (let index = 0; index < indices.length; index += 1) {
    unique.add(indices[index] ?? 0);
  }
  return new Uint32Array(
    Array.from(unique).toSorted((left, right) => left - right),
  );
}

export function transferablesForTopologyIndexBundle(
  bundle: Viewport3DTopologyIndexBundle,
): Transferable[] {
  const transferables: Transferable[] = [];
  addArrayBufferTransferable(transferables, bundle.fallbackSurfaceEdgeIndices?.buffer);
  addArrayBufferTransferable(transferables, bundle.fallbackSurfaceIndices.buffer);
  addArrayBufferTransferable(transferables, bundle.fallbackSurfaceNodeIndices.buffer);
  addArrayBufferTransferable(
    transferables,
    bundle.fallbackVolumeEdgeIndices.buffer,
  );
  for (const prepared of bundle.magneticPartsById.values()) {
    addPreparedPartTransferables(transferables, prepared);
  }
  for (const prepared of bundle.airboxPartsById.values()) {
    addPreparedPartTransferables(transferables, prepared);
  }
  return [...new Set(transferables)];
}

function addPreparedPartTransferables(
  transferables: Transferable[],
  prepared: Viewport3DPreparedPartTopologyIndices,
): void {
  addArrayBufferTransferable(transferables, prepared.edgeIndices?.buffer);
  addArrayBufferTransferable(transferables, prepared.surfaceIndices?.buffer);
  addArrayBufferTransferable(transferables, prepared.surfaceNodeIndices?.buffer);
  addArrayBufferTransferable(transferables, prepared.volumeEdgeIndices?.buffer);
}

function addArrayBufferTransferable(
  transferables: Transferable[],
  buffer: ArrayBufferLike | undefined,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}

function buildPartVolumeEdgeIndicesFromNodes(
  part: Viewport3DTopologySurfacePartInput,
  topology: Pick<DecodedTopology, "indices" | "nodeCount">,
): Uint32Array | null {
  const nodeSet = buildPartNodeSet(part, topology.nodeCount);
  if (!nodeSet) return null;

  const selectedTetraIndices: number[] = [];
  for (let source = 0; source + 3 < topology.indices.length; source += 4) {
    const a = topology.indices[source] ?? 0;
    const b = topology.indices[source + 1] ?? 0;
    const c = topology.indices[source + 2] ?? 0;
    const d = topology.indices[source + 3] ?? 0;
    if (
      nodeSet.has(a) &&
      nodeSet.has(b) &&
      nodeSet.has(c) &&
      nodeSet.has(d)
    ) {
      selectedTetraIndices.push(a, b, c, d);
    }
  }

  return selectedTetraIndices.length
    ? buildTetraVolumeEdgeIndices(new Uint32Array(selectedTetraIndices))
    : null;
}

type PartElementClaim =
  | { end: number; start: number; type: "range" }
  | { nodeSet: Set<number>; type: "nodes" };

function buildPartElementClaim(
  part: Viewport3DTopologySurfacePartInput,
  topology: Pick<DecodedTopology, "indices" | "nodeCount">,
): PartElementClaim | null {
  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  const topologyElementCount = Math.floor(topology.indices.length / 4);
  if (elementCount > 0 && elementStart < topologyElementCount) {
    const end = Math.min(topologyElementCount, elementStart + elementCount);
    return { end, start: elementStart, type: "range" };
  }

  const nodeSet = buildPartNodeSet(part, topology.nodeCount);
  return nodeSet ? { nodeSet, type: "nodes" } : null;
}

function isElementClaimed(
  elementIndex: number,
  a: number,
  b: number,
  c: number,
  d: number,
  claims: readonly PartElementClaim[],
): boolean {
  for (const claim of claims) {
    if (claim.type === "range") {
      if (elementIndex >= claim.start && elementIndex < claim.end) {
        return true;
      }
      continue;
    }
    const nodeSet = claim.nodeSet;
    if (nodeSet.has(a) && nodeSet.has(b) && nodeSet.has(c) && nodeSet.has(d)) {
      return true;
    }
  }
  return false;
}

function buildPartNodeSet(
  part: Viewport3DTopologySurfacePartInput,
  nodeCount: number,
): Set<number> | null {
  if (part.node_indices?.length) {
    return new Set(
      part.node_indices.filter(
        (nodeIndex) =>
          Number.isInteger(nodeIndex) && nodeIndex >= 0 && nodeIndex < nodeCount,
      ),
    );
  }

  const start = Math.max(0, Math.floor(part.node_start ?? 0));
  const rawCount = part.node_count ?? part.nodeCount;
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  if (count <= 0 || start >= nodeCount) return null;

  const end = Math.min(nodeCount, start + count);
  const nodes = new Set<number>();
  for (let nodeIndex = start; nodeIndex < end; nodeIndex += 1) {
    nodes.add(nodeIndex);
  }
  return nodes;
}

function flattenSurfaceFaces(
  surfaceFaces: readonly (readonly number[])[],
): Uint32Array {
  const indices: number[] = [];

  for (const face of surfaceFaces) {
    if (face.length < 3) continue;
    const anchor = face[0] ?? 0;
    for (let index = 1; index + 1 < face.length; index += 1) {
      indices.push(anchor, face[index] ?? 0, face[index + 1] ?? 0);
    }
  }

  return new Uint32Array(indices);
}

function surfaceIndicesFromBoundaryFaces(
  topology: Pick<DecodedTopology, "boundaryFaces">,
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
  topology: Pick<DecodedTopology, "boundaryFaces">,
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

function mergeSurfaceIndexBuffers(
  buffers: readonly Uint32Array[],
  nodeCount: number,
): Uint32Array | null {
  const validBuffers = buffers.filter((buffer) => buffer.length >= 3);
  if (validBuffers.length === 0) return null;
  if (validBuffers.length === 1) return validBuffers[0] ?? null;

  const totalLength = validBuffers.reduce(
    (sum, buffer) => sum + buffer.length - (buffer.length % 3),
    0,
  );
  if (totalLength <= 0) return null;

  const merged = new Uint32Array(totalLength);
  const numericKeyBase = resolveNumericTriangleKeyBase(nodeCount);
  const seenNumeric = numericKeyBase ? new Set<number>() : null;
  const seenString = seenNumeric ? null : new Set<string>();
  let target = 0;

  for (const buffer of validBuffers) {
    for (let index = 0; index + 2 < buffer.length; index += 3) {
      const a = buffer[index] ?? 0;
      const b = buffer[index + 1] ?? 0;
      const c = buffer[index + 2] ?? 0;
      if (a >= nodeCount || b >= nodeCount || c >= nodeCount) continue;
      const key = numericKeyBase
        ? triangleNumericKey(numericKeyBase, a, b, c)
        : triangleStringKey(a, b, c);
      if (seenNumeric) {
        if (seenNumeric.has(key as number)) continue;
        seenNumeric.add(key as number);
      } else if (seenString) {
        const stringKey = key as string;
        if (seenString.has(stringKey)) continue;
        seenString.add(stringKey);
      }
      merged[target++] = a;
      merged[target++] = b;
      merged[target++] = c;
    }
  }

  return target > 0 ? merged.slice(0, target) : null;
}

function resolveNumericEdgeKeyBase(indices: Uint32Array): number | null {
  let maxIndex = 0;
  for (let index = 0; index < indices.length; index += 1) {
    const nodeIndex = indices[index] ?? 0;
    if (nodeIndex > maxIndex) {
      maxIndex = nodeIndex;
    }
  }

  const keyBase = maxIndex + 1;
  return keyBase * keyBase <= Number.MAX_SAFE_INTEGER ? keyBase : null;
}

function appendTetraEdgeByNumericKey(
  edges: number[],
  seen: Set<number>,
  keyBase: number,
  first: number,
  second: number,
): void {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = a * keyBase + b;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a, b);
}

function appendTetraEdgeByStringKey(
  edges: number[],
  seen: Set<string>,
  first: number,
  second: number,
): void {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = `${a}:${b}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a, b);
}

function appendSurfaceEdge(
  edges: Uint32Array,
  seen: Set<string>,
  edgeCount: number,
  first: number,
  second: number,
): number {
  if (first === second) return edgeCount;
  const minVal = first < second ? first : second;
  const maxVal = first > second ? first : second;
  const key = `${minVal}:${maxVal}`;
  if (seen.has(key)) return edgeCount;
  seen.add(key);
  edges[edgeCount] = minVal;
  edges[edgeCount + 1] = maxVal;
  return edgeCount + 2;
}

function isValidIndex(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function resolveNumericTriangleKeyBase(nodeCount: number): number | null {
  const keyBase = Math.max(0, Math.floor(nodeCount)) + 1;
  return keyBase ** 3 <= Number.MAX_SAFE_INTEGER ? keyBase : null;
}

function triangleNumericKey(
  keyBase: number,
  first: number,
  second: number,
  third: number,
): number {
  let a = first;
  let b = second;
  let c = third;
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  if (b > c) {
    const next = b;
    b = c;
    c = next;
  }
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  return (a * keyBase + b) * keyBase + c;
}

function triangleStringKey(first: number, second: number, third: number): string {
  let a = first;
  let b = second;
  let c = third;
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  if (b > c) {
    const next = b;
    b = c;
    c = next;
  }
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  return `${a}:${b}:${c}`;
}
