import { useMemo } from "react";
import type { DependencyList } from "react";
import * as THREE from "three";
import type { MeshDisplayScope, RenderMode } from "../fem/femMeshTypes";
import type { FemGeometryPassState } from "./femGeometryRenderPasses";

export interface FemGeometryResourceNeeds {
  edges: boolean;
  tetraEdges: boolean;
  points: boolean;
}

export interface FemSurfaceGeometryResource {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  maxDim: number;
  geoSize: THREE.Vector3;
  vertexMap: Int32Array | null;
  displayedToOriginalFace: Int32Array | null;
  _positions: Float32Array;
  _activeElementOffsets: number[];
  _doShrink: boolean | undefined;
  _preferredFaceIndices: number[] | null;
  _resolvedBoundaryFaces: ArrayLike<number>;
}

export function resolveFemGeometryResourceNeeds({
  renderMode,
  renderPasses,
  edgeScope = "surface",
}: {
  renderMode: RenderMode;
  renderPasses?: FemGeometryPassState;
  edgeScope?: MeshDisplayScope;
}): FemGeometryResourceNeeds {
  if (renderPasses) {
    return {
      edges: renderPasses.wireframe || renderPasses.volumeMesh,
      tetraEdges:
        renderPasses.volumeMesh || (renderPasses.wireframe && edgeScope === "full"),
      points: renderPasses.points,
    };
  }
  return {
    edges:
      renderMode === "wireframe" ||
      renderMode === "surface+edges" ||
      renderMode === "mesh",
    tetraEdges:
      renderMode === "mesh" ||
      ((renderMode === "wireframe" || renderMode === "surface+edges") && edgeScope === "full"),
    points: renderMode === "points",
  };
}

export function buildFemSurfaceEdgeGeometryResource({
  enabled,
  geometry,
}: {
  enabled: boolean;
  geometry: THREE.BufferGeometry | null;
}): THREE.BufferGeometry | null {
  if (!enabled || !geometry) return null;
  try {
    const wireGeometry = new THREE.WireframeGeometry(geometry);
    wireGeometry.computeBoundingSphere();
    return wireGeometry;
  } catch (error) {
    console.warn("[fem-geometry] WireframeGeometry construction failed; falling back to material wireframe", error);
    return null;
  }
}

export function buildFemVolumeEdgeGeometryResource({
  enabled,
  nElements,
  nNodes,
  elements,
  nodes,
  centerX,
  centerY,
  centerZ,
}: {
  enabled: boolean;
  nElements: number;
  nNodes: number;
  elements: ArrayLike<number>;
  nodes: ArrayLike<number>;
  centerX: number | null;
  centerY: number | null;
  centerZ: number | null;
}): THREE.BufferGeometry | null {
  if (!enabled) return null;
  if (nElements === 0 || nNodes === 0) return null;
  try {
    const edgePairsByTet = [
      [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
    ] as const;
    const edgeSet = new Set<number>();
    const edgePairs: number[] = [];
    for (let elementIndex = 0; elementIndex < nElements; elementIndex += 1) {
      const base = elementIndex * 4;
      const tetNodes = [
        elements[base],
        elements[base + 1],
        elements[base + 2],
        elements[base + 3],
      ];
      for (const [left, right] of edgePairsByTet) {
        const leftNode = tetNodes[left];
        const rightNode = tetNodes[right];
        const lo = Math.min(leftNode, rightNode);
        const hi = Math.max(leftNode, rightNode);
        const key = lo * nNodes + hi;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edgePairs.push(lo, hi);
      }
    }
    const nEdges = edgePairs.length / 2;
    const cx = centerX ?? 0;
    const cy = centerY ?? 0;
    const cz = centerZ ?? 0;
    const positions = new Float32Array(nEdges * 6);
    for (let edgeIndex = 0; edgeIndex < nEdges; edgeIndex += 1) {
      const idxA = edgePairs[edgeIndex * 2];
      const idxB = edgePairs[edgeIndex * 2 + 1];
      positions[edgeIndex * 6 + 0] = Number(nodes[idxA * 3 + 0]) - cx;
      positions[edgeIndex * 6 + 1] = Number(nodes[idxA * 3 + 1]) - cy;
      positions[edgeIndex * 6 + 2] = Number(nodes[idxA * 3 + 2]) - cz;
      positions[edgeIndex * 6 + 3] = Number(nodes[idxB * 3 + 0]) - cx;
      positions[edgeIndex * 6 + 4] = Number(nodes[idxB * 3 + 1]) - cy;
      positions[edgeIndex * 6 + 5] = Number(nodes[idxB * 3 + 2]) - cz;
    }
    const tetraGeometry = new THREE.BufferGeometry();
    tetraGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    tetraGeometry.computeBoundingSphere();
    return tetraGeometry;
  } catch (error) {
    console.warn("[fem-geometry] Tetrahedral edge geometry construction failed", error);
    return null;
  }
}

function collectFaceNodeIndices(boundaryFaces: ArrayLike<number>, faceIndices: readonly number[]): number[] {
  const maxFaces = Math.floor(boundaryFaces.length / 3);
  const unique = new Set<number>();
  for (const faceIndex of faceIndices) {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= maxFaces) continue;
    const base = faceIndex * 3;
    unique.add(boundaryFaces[base]);
    unique.add(boundaryFaces[base + 1]);
    unique.add(boundaryFaces[base + 2]);
  }
  return Array.from(unique);
}

function collectElementNodeIndices(
  elements: ArrayLike<number>,
  nElements: number,
  elementOffsets: readonly number[],
): number[] {
  const unique = new Set<number>();
  for (const elementOffset of elementOffsets) {
    if (
      !Number.isInteger(elementOffset) ||
      elementOffset < 0 ||
      elementOffset + 3 >= elements.length ||
      Math.trunc(elementOffset / 4) >= nElements
    ) {
      continue;
    }
    unique.add(elements[elementOffset]);
    unique.add(elements[elementOffset + 1]);
    unique.add(elements[elementOffset + 2]);
    unique.add(elements[elementOffset + 3]);
  }
  return Array.from(unique);
}

function createPointsGeometry(
  positions: Float32Array,
  enableGeometryVertexColors: boolean,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  if (enableGeometryVertexColors) {
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(positions.length), 3));
  }
  return geometry;
}

export interface FemPointsGeometryResource {
  pointsGeometry: THREE.BufferGeometry | null;
  pointsVertexMap: Int32Array | null;
}

export function buildFemPointsGeometryResource({
  enabled,
  pointsScope,
  surfaceGeometry,
  vertexMap,
  nNodes,
  enableGeometryVertexColors,
  positions,
  boundaryFaces,
  customBoundaryFaces,
  activeElementOffsets,
  elements,
  nElements,
  preferredFaceIndices,
}: {
  enabled: boolean;
  pointsScope: MeshDisplayScope;
  surfaceGeometry: THREE.BufferGeometry | null;
  vertexMap: Int32Array | null;
  nNodes: number;
  enableGeometryVertexColors: boolean;
  positions: Float32Array | null;
  boundaryFaces: ArrayLike<number>;
  customBoundaryFaces?: readonly [number, number, number][] | null;
  activeElementOffsets: readonly number[];
  elements: ArrayLike<number>;
  nElements: number;
  preferredFaceIndices: readonly number[] | null;
}): FemPointsGeometryResource {
  if (!enabled) {
    return { pointsGeometry: null, pointsVertexMap: null };
  }

  if (pointsScope === "full" && positions) {
    const pointNodeIndices =
      activeElementOffsets.length > 0
        ? collectElementNodeIndices(elements, nElements, activeElementOffsets)
        : Array.from({ length: nNodes }, (_, index) => index);
    const pointPositions = new Float32Array(pointNodeIndices.length * 3);
    const pointVMap = new Int32Array(pointNodeIndices.length);
    for (let i = 0; i < pointNodeIndices.length; i += 1) {
      const nodeIndex = pointNodeIndices[i];
      pointVMap[i] = nodeIndex;
      const base = nodeIndex * 3;
      pointPositions[i * 3] = positions[base];
      pointPositions[i * 3 + 1] = positions[base + 1];
      pointPositions[i * 3 + 2] = positions[base + 2];
    }
    return {
      pointsGeometry: createPointsGeometry(pointPositions, enableGeometryVertexColors),
      pointsVertexMap: pointVMap,
    };
  }

  const displayedPositions = surfaceGeometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (displayedPositions && displayedPositions.count > 0) {
    const sourceArray = displayedPositions.array as ArrayLike<number>;
    const pointPositions = new Float32Array(displayedPositions.count * 3);
    for (let index = 0; index < pointPositions.length; index += 1) {
      pointPositions[index] = Number(sourceArray[index] ?? 0);
    }
    const pointVMap =
      vertexMap && vertexMap.length === displayedPositions.count
        ? new Int32Array(vertexMap)
        : displayedPositions.count === nNodes
          ? Int32Array.from({ length: nNodes }, (_, index) => index)
          : null;
    return {
      pointsGeometry: createPointsGeometry(pointPositions, enableGeometryVertexColors),
      pointsVertexMap: pointVMap,
    };
  }

  if (!positions) {
    return { pointsGeometry: null, pointsVertexMap: null };
  }

  const pointNodeIndices =
    customBoundaryFaces && customBoundaryFaces.length > 0
      ? collectFaceNodeIndices(
          boundaryFaces,
          Array.from({ length: Math.floor(boundaryFaces.length / 3) }, (_, index) => index),
        )
      : activeElementOffsets.length > 0
        ? collectElementNodeIndices(elements, nElements, activeElementOffsets)
        : preferredFaceIndices
          ? collectFaceNodeIndices(boundaryFaces, preferredFaceIndices)
          : Array.from({ length: nNodes }, (_, index) => index);
  const pointPositions = new Float32Array(pointNodeIndices.length * 3);
  const pointVMap = new Int32Array(pointNodeIndices.length);
  for (let i = 0; i < pointNodeIndices.length; i += 1) {
    const nodeIndex = pointNodeIndices[i];
    pointVMap[i] = nodeIndex;
    const base = nodeIndex * 3;
    pointPositions[i * 3] = positions[base];
    pointPositions[i * 3 + 1] = positions[base + 1];
    pointPositions[i * 3 + 2] = positions[base + 2];
  }
  return {
    pointsGeometry: createPointsGeometry(pointPositions, enableGeometryVertexColors),
    pointsVertexMap: pointVMap,
  };
}

export function useFemEdgeGeometryResource(args: {
  needs: Pick<FemGeometryResourceNeeds, "edges" | "tetraEdges">;
  surfaceGeometry: THREE.BufferGeometry | null;
  nElements: number;
  nNodes: number;
  elements: ArrayLike<number>;
  nodes: ArrayLike<number>;
  centerX: number | null;
  centerY: number | null;
  centerZ: number | null;
}): {
  edgesGeometry: THREE.BufferGeometry | null;
  tetraEdgesGeometry: THREE.BufferGeometry | null;
} {
  const edgesGeometry = useMemo(
    () => buildFemSurfaceEdgeGeometryResource({
      enabled: args.needs.edges,
      geometry: args.surfaceGeometry,
    }),
    [args.needs.edges, args.surfaceGeometry],
  );

  const tetraEdgesGeometry = useMemo(
    () => buildFemVolumeEdgeGeometryResource({
      enabled: args.needs.tetraEdges,
      nElements: args.nElements,
      nNodes: args.nNodes,
      elements: args.elements,
      nodes: args.nodes,
      centerX: args.centerX,
      centerY: args.centerY,
      centerZ: args.centerZ,
    }),
    [
      args.centerX,
      args.centerY,
      args.centerZ,
      args.elements,
      args.needs.tetraEdges,
      args.nElements,
      args.nNodes,
      args.nodes,
    ],
  );

  return { edgesGeometry, tetraEdgesGeometry };
}

export function useFemSurfaceGeometryResource(
  build: () => FemSurfaceGeometryResource,
  deps: DependencyList,
): FemSurfaceGeometryResource {
  return useMemo(build, deps);
}

export function useFemPointsGeometryResource(args: {
  needs: Pick<FemGeometryResourceNeeds, "points">;
  pointsScope: MeshDisplayScope;
  surfaceGeometry: THREE.BufferGeometry | null;
  vertexMap: Int32Array | null;
  nNodes: number;
  enableGeometryVertexColors: boolean;
  positions: Float32Array | null;
  boundaryFaces: ArrayLike<number>;
  customBoundaryFaces?: readonly [number, number, number][] | null;
  activeElementOffsets: readonly number[];
  elements: ArrayLike<number>;
  nElements: number;
  preferredFaceIndices: readonly number[] | null;
}): FemPointsGeometryResource {
  return useMemo(
    () => buildFemPointsGeometryResource({
      enabled: args.needs.points,
      pointsScope: args.pointsScope,
      surfaceGeometry: args.surfaceGeometry,
      vertexMap: args.vertexMap,
      nNodes: args.nNodes,
      enableGeometryVertexColors: args.enableGeometryVertexColors,
      positions: args.positions,
      boundaryFaces: args.boundaryFaces,
      customBoundaryFaces: args.customBoundaryFaces,
      activeElementOffsets: args.activeElementOffsets,
      elements: args.elements,
      nElements: args.nElements,
      preferredFaceIndices: args.preferredFaceIndices,
    }),
    [
      args.activeElementOffsets,
      args.boundaryFaces,
      args.customBoundaryFaces,
      args.elements,
      args.enableGeometryVertexColors,
      args.needs.points,
      args.nElements,
      args.nNodes,
      args.pointsScope,
      args.positions,
      args.preferredFaceIndices,
      args.surfaceGeometry,
      args.vertexMap,
    ],
  );
}
