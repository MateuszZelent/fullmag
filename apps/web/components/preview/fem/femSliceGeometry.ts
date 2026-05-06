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

// ── Projection (Z-averaged) slice ────────────────────────────────

/** Result of a projection (thickness-averaged) slice computation. */
export interface ProjectionResult {
  /** Row-major raster: values[iy * xRes + ix]. NaN = no data. */
  values: Float64Array;
  xRes: number;
  yRes: number;
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  valueRange: { min: number; max: number };
  normalLabel: string;
  uLabel: string;
  vLabel: string;
  /** Number of Z-planes actually sampled. */
  nPlanesSampled: number;
}

export interface ProjectionOptions {
  /** Number of planes to sample along the normal axis. Default: 20. */
  nPlanes?: number;
  /** Grid resolution (pixels per axis). Default: 128. */
  resolution?: number;
  /** Maximum number of tetrahedra sampled per projection plane. Default: all visible elements. */
  maxElements?: number;
  /** Reduction used when multiple 3D samples project into one 2D pixel. */
  reduction?: ProjectionReduction;
  /** Treat empty sampled columns as explicit zero-valued pixels. */
  includeAirAsZero?: boolean;
}

export type ProjectionReduction =
  | "mean_occupied"
  | "sum"
  | "thickness_integral"
  | "area_weighted_mean"
  | "min"
  | "max"
  | "rms"
  | "stddev"
  | "abs_max";

function limitProjectionVisibility(
  meshData: FemMeshData,
  visibility: SliceVisibilityState | null,
  maxElements: number,
): SliceVisibilityState | null {
  const nElements = meshData.nElements || Math.floor(meshData.elements.length / 4);
  if (maxElements <= 0 || nElements <= maxElements) {
    return visibility;
  }

  const visibleElements = new Uint8Array(nElements);
  const sourceMask = visibility?.visibleElements ?? null;
  const visibleCount = sourceMask
    ? sourceMask.reduce((count, value) => count + (value === 1 ? 1 : 0), 0)
    : nElements;
  if (visibleCount <= maxElements) {
    return visibility;
  }

  const stride = Math.max(1, Math.ceil(visibleCount / maxElements));
  let seenVisible = 0;
  for (let elementIndex = 0; elementIndex < nElements; elementIndex += 1) {
    if (sourceMask && sourceMask[elementIndex] !== 1) continue;
    if (seenVisible % stride === 0) {
      visibleElements[elementIndex] = 1;
    }
    seenVisible += 1;
  }

  if (visibility) {
    return {
      ...visibility,
      visibleElements,
    };
  }

  return {
    visibleElements,
    visibleBoundaryFaces: null,
    elementPartIds: [],
    boundaryFacePartIds: [],
    partById: new Map(),
    visiblePartIds: new Set(),
  };
}

/**
 * Compute a thickness-averaged (projection) slice.
 *
 * Samples `nPlanes` evenly-spaced planes along the normal axis,
 * rasterizes polygon values from each plane onto a common regular grid
 * using centroid-in-cell assignment, and averages the accumulated values.
 *
 * This is the engine behind the "All layers" / COMSOL-style top-down view.
 */
export function computeProjectionSlice(
  meshData: FemMeshData,
  plane: SlicePlane,
  component: VectorComponent,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy = "visible-context",
  options?: ProjectionOptions,
): ProjectionResult {
  const nPlanes = Math.max(1, Math.min(512, Math.round(options?.nPlanes ?? 20)));
  const resolution = Math.max(1, Math.min(2048, Math.round(options?.resolution ?? 128)));
  const maxElements = Math.max(0, Math.round(options?.maxElements ?? 0));
  const reduction = options?.reduction ?? "mean_occupied";
  const includeAirAsZero = options?.includeAirAsZero ?? false;
  const projectionVisibility = limitProjectionVisibility(meshData, visibility, maxElements);
  const { normal, u, v } = axisIndices(plane);

  // ── 1. Determine normal-axis extent from visible mesh nodes ────
  const flatNodes = meshData.nodes;
  const numNodes = flatNodes.length / 3;
  let normalMin = Number.POSITIVE_INFINITY;
  let normalMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < numNodes; i++) {
    const val = flatNodes[i * 3 + normal];
    if (val < normalMin) normalMin = val;
    if (val > normalMax) normalMax = val;
  }
  if (!Number.isFinite(normalMin) || !Number.isFinite(normalMax) || normalMin >= normalMax) {
    return emptyProjectionResult(plane, resolution);
  }

  // ── 2. Determine in-plane bounds from first slice ──────────────
  // Sample the midpoint to get a representative bounds estimate.
  const midCoord = (normalMin + normalMax) / 2;
  const probeSlice = collectSegments(
    meshData, plane, component, midCoord, projectionVisibility, boundsStrategy,
  );
  const bounds = probeSlice.bounds;
  const uRange = bounds.uMax - bounds.uMin;
  const vRange = bounds.vMax - bounds.vMin;
  if (uRange <= 0 || vRange <= 0) {
    return emptyProjectionResult(plane, resolution);
  }

  // ── 3. Determine grid resolution (preserve aspect ratio) ──────
  let xRes: number;
  let yRes: number;
  if (uRange >= vRange) {
    xRes = resolution;
    yRes = Math.max(1, Math.round(resolution * (vRange / uRange)));
  } else {
    yRes = resolution;
    xRes = Math.max(1, Math.round(resolution * (uRange / vRange)));
  }

  const cellWidth = uRange / xRes;
  const cellHeight = vRange / yRes;

  // ── 4. Accumulation buffers ───────────────────────────────────
  const totalCells = xRes * yRes;
  const sumBuf = new Float64Array(totalCells); // accumulated values
  const cntBuf = new Float64Array(totalCells); // sample count per cell
  const sumSqBuf = new Float64Array(totalCells);
  const minBuf = new Float64Array(totalCells);
  const maxBuf = new Float64Array(totalCells);
  const weightedSumBuf = new Float64Array(totalCells);
  const weightBuf = new Float64Array(totalCells);
  minBuf.fill(Number.POSITIVE_INFINITY);
  maxBuf.fill(Number.NEGATIVE_INFINITY);

  // ── 5. Sample N planes and rasterize ──────────────────────────
  const step = (normalMax - normalMin) / (nPlanes + 1);
  let planesSampled = 0;

  for (let pi = 1; pi <= nPlanes; pi++) {
    const planeCoord = normalMin + step * pi;
    const slice = collectSegments(
      meshData, plane, component, planeCoord, projectionVisibility, boundsStrategy,
    );

    // Rasterize polygon centroids into the grid
    for (const polygon of slice.polygons) {
      if (polygon.points.length < 3) continue;

      // Compute centroid in 2D
      let cu = 0;
      let cv = 0;
      for (const [pu, pv] of polygon.points) {
        cu += pu;
        cv += pv;
      }
      cu /= polygon.points.length;
      cv /= polygon.points.length;

      // Map to grid cell
      const ix = Math.floor((cu - bounds.uMin) / cellWidth);
      const iy = Math.floor((cv - bounds.vMin) / cellHeight);
      if (ix < 0 || ix >= xRes || iy < 0 || iy >= yRes) continue;

      const cellIndex = iy * xRes + ix;
      const area = Math.max(1e-30, polygonArea2D(polygon.points));
      sumBuf[cellIndex] += polygon.value;
      cntBuf[cellIndex] += 1;
      sumSqBuf[cellIndex] += polygon.value * polygon.value;
      minBuf[cellIndex] = Math.min(minBuf[cellIndex], polygon.value);
      maxBuf[cellIndex] = Math.max(maxBuf[cellIndex], polygon.value);
      weightedSumBuf[cellIndex] += polygon.value * area;
      weightBuf[cellIndex] += area;
    }

    planesSampled++;
  }

  // ── 6. Average and compute value range ────────────────────────
  const values = new Float64Array(totalCells);
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < totalCells; i++) {
    if (cntBuf[i] > 0) {
      const value = reduceProjectionCell({
        reduction,
        sum: sumBuf[i],
        sumSq: sumSqBuf[i],
        count: cntBuf[i],
        min: minBuf[i],
        max: maxBuf[i],
        weightedSum: weightedSumBuf[i],
        weight: weightBuf[i],
        normalStep: step,
        nPlanes,
        includeAirAsZero,
      });
      values[i] = value;
      if (value < vMin) vMin = value;
      if (value > vMax) vMax = value;
    } else if (includeAirAsZero) {
      values[i] = 0;
      vMin = Math.min(vMin, 0);
      vMax = Math.max(vMax, 0);
    } else {
      values[i] = NaN;
    }
  }

  if (!Number.isFinite(vMin)) vMin = 0;
  if (!Number.isFinite(vMax)) vMax = 0;

  return {
    values,
    xRes,
    yRes,
    bounds,
    valueRange: finalizeRange(vMin, vMax, component),
    normalLabel: axisLabel(normal),
    uLabel: axisLabel(u),
    vLabel: axisLabel(v),
    nPlanesSampled: planesSampled,
  };
}

function polygonArea2D(points: Point2[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twiceArea) / 2;
}

function reduceProjectionCell(args: {
  reduction: ProjectionReduction;
  sum: number;
  sumSq: number;
  count: number;
  min: number;
  max: number;
  weightedSum: number;
  weight: number;
  normalStep: number;
  nPlanes: number;
  includeAirAsZero: boolean;
}): number {
  switch (args.reduction) {
    case "sum":
      return args.sum;
    case "min":
      return args.min;
    case "max":
      return args.max;
    case "rms":
      return args.count > 0 ? Math.sqrt(args.sumSq / args.count) : 0;
    case "stddev": {
      if (args.count <= 0) return 0;
      const mean = args.sum / args.count;
      const variance = Math.max(0, args.sumSq / args.count - mean * mean);
      return Math.sqrt(variance);
    }
    case "abs_max":
      return Math.abs(args.min) >= Math.abs(args.max) ? args.min : args.max;
    case "thickness_integral":
      return args.sum * args.normalStep;
    case "area_weighted_mean":
      if (args.weight > 0) return args.weightedSum / args.weight;
      return 0;
    case "mean_occupied":
    default: {
      const denominator = args.includeAirAsZero
        ? Math.max(args.nPlanes, args.count)
        : args.count;
      return denominator > 0 ? args.sum / denominator : 0;
    }
  }
}

function emptyProjectionResult(plane: SlicePlane, resolution: number): ProjectionResult {
  const { normal, u, v } = axisIndices(plane);
  return {
    values: new Float64Array(0),
    xRes: 0,
    yRes: 0,
    bounds: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
    valueRange: { min: 0, max: 0 },
    normalLabel: axisLabel(normal),
    uLabel: axisLabel(u),
    vLabel: axisLabel(v),
    nPlanesSampled: 0,
  };
}
