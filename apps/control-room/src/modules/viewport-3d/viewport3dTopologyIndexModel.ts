import type { DecodedTopology } from "@/kernel/api/codecs";

type Viewport3DTopologyCells = Pick<
  DecodedTopology,
  | "cellNodes"
  | "cellOffsets"
  | "cellTypes"
  | "indices"
  | "nodeCount"
>;

type Viewport3DTopologyFacets = Pick<
  DecodedTopology,
  | "boundaryFaces"
  | "facetNodes"
  | "facetOffsets"
  | "facetTypes"
>;

type Viewport3DTopologyInput = Viewport3DTopologyCells & Viewport3DTopologyFacets;

const CELL_FACES: Readonly<Record<number, readonly (readonly number[])[]>> = {
  1: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
  2: [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
  3: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
  4: [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ],
};

const CELL_EDGES: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
  2: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]],
  3: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]],
  4: [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6],
    [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
  ],
};

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
  surface_node_indices?: readonly number[] | null;
  surface_faces?: readonly (readonly number[])[];
}

export interface Viewport3DTopologyIndexPartInput
  extends Viewport3DTopologySurfacePartInput {
  id: string;
}

export interface Viewport3DPreparedPartTopologyIndices {
  edgeIndices: Uint32Array | null;
  surfaceIndices: Uint32Array | null;
  surfaceTriangleFacetIndices: Uint32Array | null;
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
  topology: Viewport3DTopologyInput;
}): Viewport3DTopologyIndexBundle {
  const fallbackSurfaceIndices = buildTopologySurfaceIndices(topology);
  const fallbackSurfaceEdgeIndices = buildTopologySurfaceEdgeIndices(topology);
  const fallbackSurfaceNodeIndices = uniqueSortedIndices(fallbackSurfaceIndices);
  const fallbackVolumeEdgeIndices = buildTopologyVolumeEdgeIndices(topology);
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
  topology: Viewport3DTopologyInput;
}): Viewport3DPreparedPartTopologyIndices {
  const surfaceTriangles = buildPartSurfaceTrianglesWithSupplemental(
    part,
    topology,
    supplementalSurfaceParts,
  );
  const surfaceIndices = surfaceTriangles.indices;
  const surfaceNodeIndices = part.surface_node_indices != null
    ? uniqueSortedIndices(Uint32Array.from(part.surface_node_indices))
    : surfaceIndices
      ? uniqueSortedIndices(surfaceIndices)
      : null;
  return {
    edgeIndices: buildPartSurfaceEdgeIndicesWithSupplemental(
      part,
      topology,
      supplementalSurfaceParts,
    ),
    surfaceIndices,
    surfaceTriangleFacetIndices: surfaceTriangles.facetIndices,
    surfaceNodeIndices,
    surfaceNodeSelection: surfaceNodeIndices
      ? { nodeIndices: Array.from(surfaceNodeIndices) }
      : null,
    volumeEdgeIndices:
      buildPartVolumeEdgeIndices(part, topology) ?? fallbackVolumeEdgeIndices,
  };
}

export function buildPartSurfaceTriangleFacetIndices(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyFacets & Pick<DecodedTopology, "nodeCount">,
): Uint32Array | null {
  return buildPartSurfaceTrianglesWithSupplemental(part, topology, []).facetIndices;
}

export function buildPartSurfaceTriangleFacetIndicesWithSupplemental(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyFacets & Pick<DecodedTopology, "nodeCount">,
  supplemental: readonly Viewport3DTopologySurfacePartInput[],
  surfaceIndices: Uint32Array | null,
): Uint32Array | null {
  void surfaceIndices;
  return buildPartSurfaceTrianglesWithSupplemental(part, topology, supplemental)
    .facetIndices;
}

function buildPartSurfaceTrianglesWithSupplemental(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyFacets & Pick<DecodedTopology, "nodeCount">,
  supplemental: readonly Viewport3DTopologySurfacePartInput[],
): { facetIndices: Uint32Array | null; indices: Uint32Array | null } {
  const facets: number[] = [];
  const indices: number[] = [];
  const seen = new Set<string>();
  for (const sourcePart of [part, ...supplemental]) {
    for (const { facet, nodes } of semanticPartFaces(sourcePart, topology)) {
      const triangles: number[] = [];
      appendTriangulatedFace(triangles, nodes);
      for (let offset = 0; offset + 2 < triangles.length; offset += 3) {
        const a = triangles[offset] ?? 0;
        const b = triangles[offset + 1] ?? 0;
        const c = triangles[offset + 2] ?? 0;
        if (a >= topology.nodeCount || b >= topology.nodeCount || c >= topology.nodeCount) {
          continue;
        }
        const key = `${nodes.length}:${triangleStringKey(a, b, c)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        indices.push(a, b, c);
        facets.push(facet);
      }
    }
  }
  return {
    facetIndices: facets.length ? Uint32Array.from(facets) : null,
    indices: indices.length ? Uint32Array.from(indices) : null,
  };
}

export function buildPartSurfaceEdgeIndicesWithSupplemental(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyFacets,
  supplemental: readonly Viewport3DTopologySurfacePartInput[],
): Uint32Array | null {
  return buildSemanticFaceEdgeIndices(
    [part, ...supplemental].flatMap((sourcePart) =>
      semanticPartFaces(sourcePart, topology).map(({ nodes }) => nodes),
    ),
  );
}

function semanticPartFaces(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyFacets,
): Array<{ facet: number; nodes: readonly number[] }> {
  if (part.surface_faces?.length) {
    const exactFacetIndices = part.boundary_face_indices;
    if (exactFacetIndices?.length !== part.surface_faces.length) return [];
    return part.surface_faces.flatMap((nodes, index) => {
      const facet = exactFacetIndices[index];
      if (facet === undefined) return [];
      return nodes.length >= 3 ? [{ facet, nodes }] : [];
    });
  }
  const facets = part.boundary_face_indices?.length
    ? part.boundary_face_indices
    : Array.from(
        { length: Math.max(0, Math.floor(part.boundary_face_count)) },
        (_unused, index) =>
          Math.max(0, Math.floor(part.boundary_face_start)) + index,
      );
  return facets.flatMap((facet) => {
    const nodes = topologyFacetNodes(topology, facet);
    return nodes && nodes.length >= 3 ? [{ facet, nodes }] : [];
  });
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

export function buildTopologySurfaceIndices(
  topology: Viewport3DTopologyCells,
): Uint32Array {
  return buildTopologySurfaceIndicesForElements(topology, null);
}

export function buildTopologySurfaceIndicesForElements(
  topology: Viewport3DTopologyCells,
  selectedElements: ReadonlySet<number> | null,
): Uint32Array {
  const triangles: number[] = [];
  for (const face of collectTopologyBoundaryFaces(topology, selectedElements)) {
    appendTriangulatedFace(triangles, face);
  }
  return Uint32Array.from(triangles);
}

function collectTopologyBoundaryFaces(
  topology: Viewport3DTopologyCells,
  selectedElements: ReadonlySet<number> | null,
): readonly (readonly number[])[] {
  const faces = new Map<string, { count: number; nodes: number[] }>();
  forEachTopologyCell(topology, (element, type, nodes) => {
    if (selectedElements && !selectedElements.has(element)) return;
    for (const localFace of CELL_FACES[type] ?? []) {
      const face = localFace.map((corner) => nodes[corner]);
      if (face.some((node) => node === undefined || node >= topology.nodeCount)) {
        continue;
      }
      const resolved = face as number[];
      const key = `${resolved.length}:${[...resolved].sort((a, b) => a - b).join(":")}`;
      const existing = faces.get(key);
      if (existing) existing.count += 1;
      else faces.set(key, { count: 1, nodes: resolved });
    }
  });

  return Array.from(faces.values()).flatMap((face) =>
    face.count === 1 ? [face.nodes] : [],
  );
}

export function buildTopologySurfaceEdgeIndices(
  topology: Viewport3DTopologyCells,
): Uint32Array | null {
  return buildSemanticFaceEdgeIndices(
    collectTopologyBoundaryFaces(topology, null),
  );
}

export function buildTopologySurfaceEdgeIndicesForElements(
  topology: Viewport3DTopologyCells,
  selectedElements: ReadonlySet<number>,
): Uint32Array | null {
  return buildSemanticFaceEdgeIndices(
    collectTopologyBoundaryFaces(topology, selectedElements),
  );
}

function buildSemanticFaceEdgeIndices(
  faces: readonly (readonly number[])[],
): Uint32Array | null {
  const edges: number[] = [];
  const seen = new Set<string>();
  for (const face of faces) {
    for (let index = 0; index < face.length; index += 1) {
      const left = face[index];
      const right = face[(index + 1) % face.length];
      if (left === undefined || right === undefined) continue;
      appendTetraEdgeByStringKey(edges, seen, left, right);
    }
  }
  return edges.length ? Uint32Array.from(edges) : null;
}

export function buildTopologyVolumeEdgeIndices(
  topology: Viewport3DTopologyCells,
): Uint32Array {
  return buildTopologyVolumeEdgeIndicesWhere(topology, () => true);
}

export function buildTopologyVolumeEdgeIndicesForElements(
  topology: Viewport3DTopologyCells,
  selectedElements: ReadonlySet<number>,
): Uint32Array {
  return buildTopologyVolumeEdgeIndicesWhere(
    topology,
    (element) => selectedElements.has(element),
  );
}

export function topologyCellAt(
  topology: Viewport3DTopologyCells,
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
    const start = topology.cellOffsets[element] ?? 0;
    const end = topology.cellOffsets[element + 1] ?? start;
    return {
      nodes: Array.from(topology.cellNodes.subarray(start, end)),
      type: topology.cellTypes[element] ?? 0,
    };
  }
  const start = element * 4;
  if (start + 3 >= topology.indices.length) return null;
  return {
    nodes: Array.from(topology.indices.subarray(start, start + 4)),
    type: 1,
  };
}

export function topologyCellEdges(
  topology: Viewport3DTopologyCells,
  element: number,
): readonly (readonly [number, number])[] {
  const cell = topologyCellAt(topology, element);
  if (!cell) return [];
  return (CELL_EDGES[cell.type] ?? []).flatMap(([leftCorner, rightCorner]) => {
    const left = cell.nodes[leftCorner];
    const right = cell.nodes[rightCorner];
    return left === undefined || right === undefined ? [] : [[left, right] as const];
  });
}

export function buildPartSurfaceIndices(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyFacets & Pick<DecodedTopology, "nodeCount">,
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
  topology: Viewport3DTopologyFacets & Pick<DecodedTopology, "nodeCount">,
  supplementalSurfaceParts: readonly Viewport3DTopologySurfacePartInput[],
): Uint32Array | null {
  return buildPartSurfaceTrianglesWithSupplemental(
    part,
    topology,
    supplementalSurfaceParts,
  ).indices;
}

export function buildPartVolumeEdgeIndices(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyCells,
): Uint32Array | null {
  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  if (elementCount > 0) {
    const end = Math.min(topologyCellCount(topology), elementStart + elementCount);
    if (end > elementStart) {
      return buildTopologyVolumeEdgeIndicesWhere(
        topology,
        (element) => element >= elementStart && element < end,
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
  topology: Viewport3DTopologyCells,
  claimedParts: readonly Viewport3DTopologySurfacePartInput[],
): Uint32Array | null {
  if (topologyCellCount(topology) === 0) return null;
  if (claimedParts.length === 0) {
    return buildTopologyVolumeEdgeIndices(topology);
  }

  const claims: PartElementClaim[] = [];
  for (const part of claimedParts) {
    const claim = buildPartElementClaim(part, topology);
    if (claim) {
      claims.push(claim);
    }
  }
  if (claims.length === 0) return null;

  let claimedElementCount = 0;
  const edges = buildTopologyVolumeEdgeIndicesWhere(topology, (element, nodes) => {
    const claimed = isElementClaimed(element, nodes, claims);
    if (claimed) claimedElementCount += 1;
    return !claimed;
  });

  if (claimedElementCount === 0) return null;

  return edges.length ? edges : null;
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
  addArrayBufferTransferable(
    transferables,
    prepared.surfaceTriangleFacetIndices?.buffer,
  );
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
  topology: Viewport3DTopologyCells,
): Uint32Array | null {
  const nodeSet = buildPartNodeSet(part, topology.nodeCount);
  if (!nodeSet) return null;

  const edges = buildTopologyVolumeEdgeIndicesWhere(
    topology,
    (_element, nodes) => nodes.every((node) => nodeSet.has(node)),
  );
  return edges.length ? edges : null;
}

type PartElementClaim =
  | { end: number; start: number; type: "range" }
  | { nodeSet: Set<number>; type: "nodes" };

function buildPartElementClaim(
  part: Viewport3DTopologySurfacePartInput,
  topology: Viewport3DTopologyCells,
): PartElementClaim | null {
  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  const topologyElementCount = topologyCellCount(topology);
  if (elementCount > 0 && elementStart < topologyElementCount) {
    const end = Math.min(topologyElementCount, elementStart + elementCount);
    return { end, start: elementStart, type: "range" };
  }

  const nodeSet = buildPartNodeSet(part, topology.nodeCount);
  return nodeSet ? { nodeSet, type: "nodes" } : null;
}

function isElementClaimed(
  elementIndex: number,
  nodes: readonly number[],
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
    if (nodes.every((node) => nodeSet.has(node))) {
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
    appendTriangulatedFace(indices, face);
  }

  return new Uint32Array(indices);
}

function surfaceIndicesFromBoundaryFaces(
  topology: Viewport3DTopologyFacets,
  faceIndices: readonly number[],
): Uint32Array | null {
  if (!faceIndices.length) return null;
  const indices: number[] = [];
  for (const faceIndex of faceIndices) {
    const nodes = topologyFacetNodes(topology, faceIndex);
    if (nodes) appendTriangulatedFace(indices, nodes);
  }
  return indices.length ? Uint32Array.from(indices) : null;
}

function surfaceIndicesFromBoundaryFaceRange(
  topology: Viewport3DTopologyFacets,
  start: number,
  count: number,
): Uint32Array | null {
  const safeStart = Math.max(0, Math.floor(start));
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return null;

  const faceIndices = Array.from(
    { length: safeCount },
    (_unused, index) => safeStart + index,
  );
  return surfaceIndicesFromBoundaryFaces(topology, faceIndices);
}

function appendTriangulatedFace(target: number[], face: readonly number[]): void {
  if (face.length < 3) return;
  const anchor = face[0] ?? 0;
  for (let index = 1; index + 1 < face.length; index += 1) {
    target.push(anchor, face[index] ?? 0, face[index + 1] ?? 0);
  }
}

function topologyCellCount(topology: Viewport3DTopologyCells): number {
  if (
    topology.cellTypes &&
    topology.cellOffsets &&
    topology.cellNodes &&
    topology.cellOffsets.length === topology.cellTypes.length + 1
  ) {
    return topology.cellTypes.length;
  }
  return Math.floor(topology.indices.length / 4);
}

function forEachTopologyCell(
  topology: Viewport3DTopologyCells,
  visit: (element: number, type: number, nodes: readonly number[]) => void,
): void {
  if (
    topology.cellTypes &&
    topology.cellOffsets &&
    topology.cellNodes &&
    topology.cellOffsets.length === topology.cellTypes.length + 1
  ) {
    for (let element = 0; element < topology.cellTypes.length; element += 1) {
      const start = topology.cellOffsets[element] ?? 0;
      const end = topology.cellOffsets[element + 1] ?? start;
      visit(element, topology.cellTypes[element] ?? 0, Array.from(topology.cellNodes.subarray(start, end)));
    }
    return;
  }

  for (let source = 0, element = 0; source + 3 < topology.indices.length; source += 4, element += 1) {
    visit(element, 1, Array.from(topology.indices.subarray(source, source + 4)));
  }
}

function buildTopologyVolumeEdgeIndicesWhere(
  topology: Viewport3DTopologyCells,
  include: (element: number, nodes: readonly number[]) => boolean,
): Uint32Array {
  const edges: number[] = [];
  const seen = new Set<string>();
  forEachTopologyCell(topology, (element, type, nodes) => {
    if (!include(element, nodes)) return;
    for (const [leftCorner, rightCorner] of CELL_EDGES[type] ?? []) {
      const left = nodes[leftCorner];
      const right = nodes[rightCorner];
      if (left === undefined || right === undefined) continue;
      appendTetraEdgeByStringKey(edges, seen, left, right);
    }
  });
  return Uint32Array.from(edges);
}

function topologyFacetNodes(
  topology: Viewport3DTopologyFacets,
  facet: number,
): readonly number[] | null {
  if (
    topology.facetNodes &&
    topology.facetOffsets &&
    topology.facetTypes &&
    topology.facetOffsets.length === topology.facetTypes.length + 1 &&
    facet >= 0 &&
    facet < topology.facetTypes.length
  ) {
    const start = topology.facetOffsets[facet] ?? 0;
    const end = topology.facetOffsets[facet + 1] ?? start;
    return Array.from(topology.facetNodes.subarray(start, end));
  }
  const start = facet * 3;
  if (start + 2 >= topology.boundaryFaces.length) return null;
  return Array.from(topology.boundaryFaces.subarray(start, start + 3));
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
