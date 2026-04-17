import type { FemMeshData } from "./femMeshTypes";
import type { SliceVisibilityState } from "./femSliceUtils";

export type SlicePlane = "xy" | "xz" | "yz";
export type VectorComponent = "x" | "y" | "z" | "magnitude";
export type Point3 = [number, number, number];
export type Point2 = [number, number];
export type SliceBoundsStrategy = "visible-context" | "visible-intersection";

export interface Segment2D {
  a: Point2;
  b: Point2;
  va: number;
  vb: number;
}

export interface Polygon2D {
  points: Point2[];
  value: number;
  partId: string | null;
  worldPoint: Point3 | null;
  worldVector: Point3 | null;
}

export interface SliceArrow2D {
  origin: Point2;
  vector: Point2;
  magnitude: number;
  partId: string | null;
  worldPoint: Point3;
  worldVector: Point3;
}

export interface SliceCollection {
  planeCoord: number;
  normalLabel: string;
  uLabel: string;
  vLabel: string;
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  segments: Segment2D[];
  polygons: Polygon2D[];
  arrows: SliceArrow2D[];
  valueRange: { min: number; max: number };
}

export type SliceSampleRef =
  | { kind: "node"; nodeIndex: number }
  | { kind: "edge"; nodeA: number; nodeB: number; t: number };

export interface BoundarySegmentTopology2D {
  a: Point2;
  b: Point2;
  sampleA: SliceSampleRef;
  sampleB: SliceSampleRef;
}

export interface PolygonTopology2D {
  points: Point2[];
  worldPoints: Point3[];
  sampleRefs: SliceSampleRef[];
  partId: string | null;
}

export interface SliceTopologyCollection {
  planeCoord: number;
  normalLabel: string;
  uLabel: string;
  vLabel: string;
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  segments: BoundarySegmentTopology2D[];
  polygons: PolygonTopology2D[];
}

interface Bounds2D {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPoint(a: Point3, b: Point3, t: number): Point3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function nodeScalar(meshData: FemMeshData, nodeIndex: number, component: VectorComponent): number {
  const fld = meshData.fieldData;
  if (!fld) return 0;
  const nComp = meshData.fieldNComp ?? 3;
  const fx = fld.x[nodeIndex] ?? 0;
  const fy = fld.y[nodeIndex] ?? 0;
  const fz = fld.z[nodeIndex] ?? 0;
  if (nComp <= 1) {
    return fx;
  }
  switch (component) {
    case "x":
      return fx;
    case "y":
      return fy;
    case "z":
      return fz;
    case "magnitude":
      return Math.sqrt(fx * fx + fy * fy + fz * fz);
  }
}

function nodeVector(meshData: FemMeshData, nodeIndex: number): Point3 {
  const fld = meshData.fieldData;
  if (!fld) return [0, 0, 0];
  if ((meshData.fieldNComp ?? 3) <= 1) {
    return [0, 0, 0];
  }
  return [fld.x[nodeIndex] ?? 0, fld.y[nodeIndex] ?? 0, fld.z[nodeIndex] ?? 0];
}

function sampleScalar(meshData: FemMeshData, ref: SliceSampleRef, component: VectorComponent): number {
  if (ref.kind === "node") {
    return nodeScalar(meshData, ref.nodeIndex, component);
  }
  const a = nodeScalar(meshData, ref.nodeA, component);
  const b = nodeScalar(meshData, ref.nodeB, component);
  return lerp(a, b, ref.t);
}

function sampleVector(meshData: FemMeshData, ref: SliceSampleRef): Point3 {
  if (ref.kind === "node") {
    return nodeVector(meshData, ref.nodeIndex);
  }
  const a = nodeVector(meshData, ref.nodeA);
  const b = nodeVector(meshData, ref.nodeB);
  return [
    lerp(a[0], b[0], ref.t),
    lerp(a[1], b[1], ref.t),
    lerp(a[2], b[2], ref.t),
  ];
}

export function axisIndices(plane: SlicePlane): { normal: 0 | 1 | 2; u: 0 | 1 | 2; v: 0 | 1 | 2 } {
  switch (plane) {
    case "xy":
      return { normal: 2, u: 0, v: 1 };
    case "xz":
      return { normal: 1, u: 0, v: 2 };
    case "yz":
      return { normal: 0, u: 1, v: 2 };
  }
}

export function project(point: Point3, plane: SlicePlane): Point2 {
  const { u, v } = axisIndices(plane);
  return [point[u], point[v]];
}

function axisLabel(index: 0 | 1 | 2): string {
  return index === 0 ? "x" : index === 1 ? "y" : "z";
}

function uniqueIntersectionPoints<T extends { point: Point3 }>(points: T[], epsilon: number): T[] {
  const out: T[] = [];
  for (const candidate of points) {
    const exists = out.some(
      (entry) =>
        Math.abs(entry.point[0] - candidate.point[0]) <= epsilon &&
        Math.abs(entry.point[1] - candidate.point[1]) <= epsilon &&
        Math.abs(entry.point[2] - candidate.point[2]) <= epsilon,
    );
    if (!exists) {
      out.push(candidate);
    }
  }
  return out;
}

function sortIntersectionLoop<T extends { point: Point3 }>(points: T[], plane: SlicePlane): T[] {
  if (points.length <= 2) return points;
  const projected = points.map((entry, index) => ({ index, uv: project(entry.point, plane) }));
  const centerU = projected.reduce((sum, entry) => sum + entry.uv[0], 0) / projected.length;
  const centerV = projected.reduce((sum, entry) => sum + entry.uv[1], 0) / projected.length;
  projected.sort(
    (left, right) =>
      Math.atan2(left.uv[1] - centerV, left.uv[0] - centerU) -
      Math.atan2(right.uv[1] - centerV, right.uv[0] - centerU),
  );
  return projected.map((entry) => points[entry.index]);
}

function finalizeRange(
  valueMin: number,
  valueMax: number,
  component: VectorComponent,
): { min: number; max: number } {
  if (!Number.isFinite(valueMin)) return { min: 0, max: 0 };
  if (component === "magnitude") return { min: 0, max: Math.max(1, valueMax) };
  if (valueMin < 0 && valueMax > 0) {
    const bound = Math.max(Math.abs(valueMin), Math.abs(valueMax));
    return { min: -bound, max: bound };
  }
  return { min: valueMin, max: valueMax };
}

function includePointInBounds(bounds: Bounds2D | null, [u, v]: Point2): Bounds2D {
  if (!bounds) {
    return { uMin: u, uMax: u, vMin: v, vMax: v };
  }
  return {
    uMin: Math.min(bounds.uMin, u),
    uMax: Math.max(bounds.uMax, u),
    vMin: Math.min(bounds.vMin, v),
    vMax: Math.max(bounds.vMax, v),
  };
}

function padDegenerateBounds(bounds: Bounds2D | null): Bounds2D {
  if (!bounds) {
    return { uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5 };
  }
  const du = bounds.uMax - bounds.uMin;
  const dv = bounds.vMax - bounds.vMin;
  const padU = du > 1e-18 ? du * 0.05 : Math.max(Math.abs(bounds.uMin), Math.abs(bounds.uMax), 1) * 0.1;
  const padV = dv > 1e-18 ? dv * 0.05 : Math.max(Math.abs(bounds.vMin), Math.abs(bounds.vMax), 1) * 0.1;
  return {
    uMin: bounds.uMin - padU,
    uMax: bounds.uMax + padU,
    vMin: bounds.vMin - padV,
    vMax: bounds.vMax + padV,
  };
}

function boundsFromVisibleParts(
  visibility: SliceVisibilityState | null,
  plane: SlicePlane,
): Bounds2D | null {
  if (!visibility) return null;
  let bounds: Bounds2D | null = null;
  const { u, v } = axisIndices(plane);
  for (const partId of visibility.visiblePartIds) {
    const part = visibility.partById.get(partId);
    if (!part) continue;
    const min = part.bounds_min;
    const max = part.bounds_max;
    if (!min || !max) continue;
    bounds = includePointInBounds(bounds, [min[u], min[v]]);
    bounds = includePointInBounds(bounds, [max[u], max[v]]);
  }
  return bounds;
}

function chooseRenderBounds(args: {
  strategy: SliceBoundsStrategy;
  intersectionBounds: Bounds2D | null;
  visiblePartBounds: Bounds2D | null;
}): Bounds2D {
  const { strategy, intersectionBounds, visiblePartBounds } = args;
  if (strategy === "visible-intersection") {
    return padDegenerateBounds(intersectionBounds ?? visiblePartBounds);
  }
  return padDegenerateBounds(visiblePartBounds ?? intersectionBounds);
}

function nodeRef(nodeIndex: number): SliceSampleRef {
  return { kind: "node", nodeIndex };
}

function edgeRef(nodeA: number, nodeB: number, t: number): SliceSampleRef {
  return { kind: "edge", nodeA, nodeB, t };
}

function collectBoundaryTopology(
  meshData: FemMeshData,
  plane: SlicePlane,
  planeCoord: number,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy,
): SliceTopologyCollection {
  const flatNodes = meshData.nodes;
  const flatFaces = meshData.boundaryFaces;
  const numNodes = flatNodes.length / 3;
  const numFaces = flatFaces.length / 3;
  const { normal, u, v } = axisIndices(plane);

  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < numNodes; i++) {
    const value = flatNodes[i * 3 + normal];
    if (value < minN) minN = value;
    if (value > maxN) maxN = value;
  }
  const epsilon = Math.max((maxN - minN) * 1e-4, 1e-15);
  const segments: BoundarySegmentTopology2D[] = [];
  let intersectionBounds: Bounds2D | null = null;

  const addSegment = (pa: Point3, pb: Point3, sampleA: SliceSampleRef, sampleB: SliceSampleRef) => {
    const a = project(pa, plane);
    const b = project(pb, plane);
    intersectionBounds = includePointInBounds(intersectionBounds, a);
    intersectionBounds = includePointInBounds(intersectionBounds, b);
    segments.push({ a, b, sampleA, sampleB });
  };

  const edges = [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as const;

  for (let faceIndex = 0; faceIndex < numFaces; faceIndex++) {
    if (visibility?.visibleBoundaryFaces && visibility.visibleBoundaryFaces[faceIndex] !== 1) continue;
    const ia = flatFaces[faceIndex * 3];
    const ib = flatFaces[faceIndex * 3 + 1];
    const ic = flatFaces[faceIndex * 3 + 2];
    const ids = [ia, ib, ic] as const;
    const points: [Point3, Point3, Point3] = [
      [flatNodes[ia * 3], flatNodes[ia * 3 + 1], flatNodes[ia * 3 + 2]],
      [flatNodes[ib * 3], flatNodes[ib * 3 + 1], flatNodes[ib * 3 + 2]],
      [flatNodes[ic * 3], flatNodes[ic * 3 + 1], flatNodes[ic * 3 + 2]],
    ];
    const signed = [
      points[0][normal] - planeCoord,
      points[1][normal] - planeCoord,
      points[2][normal] - planeCoord,
    ] as const;
    const near = [
      Math.abs(signed[0]) <= epsilon,
      Math.abs(signed[1]) <= epsilon,
      Math.abs(signed[2]) <= epsilon,
    ] as const;

    if (near[0] && near[1] && near[2]) {
      addSegment(points[0], points[1], nodeRef(ids[0]), nodeRef(ids[1]));
      addSegment(points[1], points[2], nodeRef(ids[1]), nodeRef(ids[2]));
      addSegment(points[2], points[0], nodeRef(ids[2]), nodeRef(ids[0]));
      continue;
    }

    const intersections: Array<{ point: Point3; sampleRef: SliceSampleRef }> = [];
    for (const [a, b] of edges) {
      const da = signed[a];
      const db = signed[b];
      if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
        intersections.push({ point: points[a], sampleRef: nodeRef(ids[a]) });
        intersections.push({ point: points[b], sampleRef: nodeRef(ids[b]) });
        continue;
      }
      if (Math.abs(da) <= epsilon) {
        intersections.push({ point: points[a], sampleRef: nodeRef(ids[a]) });
        continue;
      }
      if (Math.abs(db) <= epsilon) {
        intersections.push({ point: points[b], sampleRef: nodeRef(ids[b]) });
        continue;
      }
      if (da * db < 0) {
        const t = da / (da - db);
        intersections.push({
          point: lerpPoint(points[a], points[b], t),
          sampleRef: edgeRef(ids[a], ids[b], t),
        });
      }
    }

    const unique = uniqueIntersectionPoints(intersections, epsilon);
    if (unique.length === 2) {
      addSegment(unique[0].point, unique[1].point, unique[0].sampleRef, unique[1].sampleRef);
    } else if (unique.length === 3) {
      unique.sort((lhs, rhs) => lhs.point[u] - rhs.point[u] || lhs.point[v] - rhs.point[v]);
      addSegment(unique[0].point, unique[1].point, unique[0].sampleRef, unique[1].sampleRef);
      addSegment(unique[1].point, unique[2].point, unique[1].sampleRef, unique[2].sampleRef);
    }
  }

  const bounds = chooseRenderBounds({
    strategy: boundsStrategy,
    intersectionBounds,
    visiblePartBounds: boundsFromVisibleParts(visibility, plane),
  });

  return {
    planeCoord,
    normalLabel: axisLabel(normal),
    uLabel: axisLabel(u),
    vLabel: axisLabel(v),
    bounds,
    segments,
    polygons: [],
  };
}

function collectTetraTopology(
  meshData: FemMeshData,
  plane: SlicePlane,
  planeCoord: number,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy,
): SliceTopologyCollection {
  const flatNodes = meshData.nodes;
  const flatElements = meshData.elements;
  const numNodes = flatNodes.length / 3;
  const numElements = flatElements.length / 4;
  const { normal, u, v } = axisIndices(plane);

  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < numNodes; i++) {
    const value = flatNodes[i * 3 + normal];
    if (value < minN) minN = value;
    if (value > maxN) maxN = value;
  }
  const epsilon = Math.max((maxN - minN) * 1e-4, 1e-15);
  const polygons: PolygonTopology2D[] = [];
  let intersectionBounds: Bounds2D | null = null;

  const edges = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ] as const;

  for (let elementIndex = 0; elementIndex < numElements; elementIndex++) {
    if (visibility?.visibleElements && visibility.visibleElements[elementIndex] !== 1) continue;
    const ids = [
      flatElements[elementIndex * 4],
      flatElements[elementIndex * 4 + 1],
      flatElements[elementIndex * 4 + 2],
      flatElements[elementIndex * 4 + 3],
    ] as const;
    const points = ids.map(
      (nodeIndex) =>
        [
          flatNodes[nodeIndex * 3],
          flatNodes[nodeIndex * 3 + 1],
          flatNodes[nodeIndex * 3 + 2],
        ] as Point3,
    ) as [Point3, Point3, Point3, Point3];
    const signed = points.map((point) => point[normal] - planeCoord) as [number, number, number, number];
    const intersections: Array<{ point: Point3; sampleRef: SliceSampleRef }> = [];

    for (const [a, b] of edges) {
      const da = signed[a];
      const db = signed[b];
      if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
        intersections.push({ point: points[a], sampleRef: nodeRef(ids[a]) });
        intersections.push({ point: points[b], sampleRef: nodeRef(ids[b]) });
        continue;
      }
      if (Math.abs(da) <= epsilon) {
        intersections.push({ point: points[a], sampleRef: nodeRef(ids[a]) });
        continue;
      }
      if (Math.abs(db) <= epsilon) {
        intersections.push({ point: points[b], sampleRef: nodeRef(ids[b]) });
        continue;
      }
      if (da * db > 0) continue;
      const t = da / (da - db);
      intersections.push({
        point: lerpPoint(points[a], points[b], t),
        sampleRef: edgeRef(ids[a], ids[b], t),
      });
    }

    const unique = sortIntersectionLoop(uniqueIntersectionPoints(intersections, epsilon), plane);
    if (unique.length < 3) continue;

    const polygonPoints: Point2[] = [];
    const worldPoints: Point3[] = [];
    const sampleRefs: SliceSampleRef[] = [];
    for (const entry of unique) {
      const projected = project(entry.point, plane);
      polygonPoints.push(projected);
      worldPoints.push(entry.point);
      sampleRefs.push(entry.sampleRef);
      intersectionBounds = includePointInBounds(intersectionBounds, projected);
    }

    polygons.push({
      points: polygonPoints,
      worldPoints,
      sampleRefs,
      partId: visibility?.elementPartIds[elementIndex] ?? null,
    });
  }

  const bounds = chooseRenderBounds({
    strategy: boundsStrategy,
    intersectionBounds,
    visiblePartBounds: boundsFromVisibleParts(visibility, plane),
  });

  return {
    planeCoord,
    normalLabel: axisLabel(normal),
    uLabel: axisLabel(u),
    vLabel: axisLabel(v),
    bounds,
    segments: [],
    polygons,
  };
}

export function collectSliceTopology(
  meshData: FemMeshData,
  plane: SlicePlane,
  planeCoord: number,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy = "visible-context",
): SliceTopologyCollection {
  return meshData.elements.length >= 4
    ? collectTetraTopology(meshData, plane, planeCoord, visibility, boundsStrategy)
    : collectBoundaryTopology(meshData, plane, planeCoord, visibility, boundsStrategy);
}

export function sampleSliceField(
  meshData: FemMeshData,
  plane: SlicePlane,
  component: VectorComponent,
  topology: SliceTopologyCollection,
): SliceCollection {
  const { u, v } = axisIndices(plane);
  const segments: Segment2D[] = [];
  const polygons: Polygon2D[] = [];
  const arrows: SliceArrow2D[] = [];
  let valueMin = Number.POSITIVE_INFINITY;
  let valueMax = Number.NEGATIVE_INFINITY;

  for (const segment of topology.segments) {
    const va = sampleScalar(meshData, segment.sampleA, component);
    const vb = sampleScalar(meshData, segment.sampleB, component);
    valueMin = Math.min(valueMin, va, vb);
    valueMax = Math.max(valueMax, va, vb);
    segments.push({
      a: segment.a,
      b: segment.b,
      va,
      vb,
    });
  }

  for (const polygon of topology.polygons) {
    let avgValue = 0;
    let avgU = 0;
    let avgV = 0;
    let avgWorldX = 0;
    let avgWorldY = 0;
    let avgWorldZ = 0;
    let avgVectorU = 0;
    let avgVectorV = 0;
    let avgVectorX = 0;
    let avgVectorY = 0;
    let avgVectorZ = 0;
    let localMin = Number.POSITIVE_INFINITY;
    let localMax = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < polygon.sampleRefs.length; index += 1) {
      const value = sampleScalar(meshData, polygon.sampleRefs[index]!, component);
      const vector = sampleVector(meshData, polygon.sampleRefs[index]!);
      const worldPoint = polygon.worldPoints[index]!;
      const projected = polygon.points[index]!;
      avgValue += value;
      avgU += projected[0];
      avgV += projected[1];
      avgWorldX += worldPoint[0];
      avgWorldY += worldPoint[1];
      avgWorldZ += worldPoint[2];
      avgVectorU += vector[u];
      avgVectorV += vector[v];
      avgVectorX += vector[0];
      avgVectorY += vector[1];
      avgVectorZ += vector[2];
      localMin = Math.min(localMin, value);
      localMax = Math.max(localMax, value);
    }

    const count = polygon.sampleRefs.length || 1;
    avgValue /= count;
    avgU /= count;
    avgV /= count;
    avgWorldX /= count;
    avgWorldY /= count;
    avgWorldZ /= count;
    avgVectorU /= count;
    avgVectorV /= count;
    avgVectorX /= count;
    avgVectorY /= count;
    avgVectorZ /= count;
    valueMin = Math.min(valueMin, localMin);
    valueMax = Math.max(valueMax, localMax);

    polygons.push({
      points: polygon.points,
      value: avgValue,
      partId: polygon.partId,
      worldPoint: [avgWorldX, avgWorldY, avgWorldZ],
      worldVector: [avgVectorX, avgVectorY, avgVectorZ],
    });
    arrows.push({
      origin: [avgU, avgV],
      vector: [avgVectorU, avgVectorV],
      magnitude: Math.hypot(avgVectorU, avgVectorV),
      partId: polygon.partId,
      worldPoint: [avgWorldX, avgWorldY, avgWorldZ],
      worldVector: [avgVectorX, avgVectorY, avgVectorZ],
    });
  }

  return {
    planeCoord: topology.planeCoord,
    normalLabel: topology.normalLabel,
    uLabel: topology.uLabel,
    vLabel: topology.vLabel,
    bounds: topology.bounds,
    segments,
    polygons,
    arrows,
    valueRange: finalizeRange(valueMin, valueMax, component),
  };
}

export function collectSegments(
  meshData: FemMeshData,
  plane: SlicePlane,
  component: VectorComponent,
  planeCoord: number,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy = "visible-context",
): SliceCollection {
  const topology = collectSliceTopology(
    meshData,
    plane,
    planeCoord,
    visibility,
    boundsStrategy,
  );
  return sampleSliceField(meshData, plane, component, topology);
}
