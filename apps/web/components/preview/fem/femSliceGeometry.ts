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
}

export interface SliceArrow2D {
  origin: Point2;
  vector: Point2;
  magnitude: number;
  partId: string | null;
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

interface Bounds2D {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  const fx = fld.x[nodeIndex] ?? 0;
  const fy = fld.y[nodeIndex] ?? 0;
  const fz = fld.z[nodeIndex] ?? 0;
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
  return [fld.x[nodeIndex] ?? 0, fld.y[nodeIndex] ?? 0, fld.z[nodeIndex] ?? 0];
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

function uniquePoints<T extends { point: Point3; value: number }>(points: T[], epsilon: number): T[] {
  const out: T[] = [];
  for (const candidate of points) {
    const exists = out.some(
      (entry) =>
        Math.abs(entry.point[0] - candidate.point[0]) <= epsilon &&
        Math.abs(entry.point[1] - candidate.point[1]) <= epsilon &&
        Math.abs(entry.point[2] - candidate.point[2]) <= epsilon,
    );
    if (!exists) out.push(candidate);
  }
  return out;
}

function sortIntersectionLoop<T extends { point: Point3; value: number }>(points: T[], plane: SlicePlane): T[] {
  if (points.length <= 2) return points;
  const projected = points.map((entry) => ({ ...entry, uv: project(entry.point, plane) }));
  const centerU = projected.reduce((sum, entry) => sum + entry.uv[0], 0) / projected.length;
  const centerV = projected.reduce((sum, entry) => sum + entry.uv[1], 0) / projected.length;
  projected.sort(
    (left, right) =>
      Math.atan2(left.uv[1] - centerV, left.uv[0] - centerU) -
      Math.atan2(right.uv[1] - centerV, right.uv[0] - centerU),
  );
  return projected.map(({ uv: _uv, ...entry }) => entry as unknown as T);
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

function collectBoundarySegments(
  meshData: FemMeshData,
  plane: SlicePlane,
  component: VectorComponent,
  planeCoord: number,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy,
): SliceCollection {
  const flatNodes = meshData.nodes;
  const flatFaces = meshData.boundaryFaces;
  const numNodes = flatNodes.length / 3;
  const numFaces = flatFaces.length / 3;
  const { normal, u, v } = axisIndices(plane);

  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < numNodes; i++) {
    const pn = flatNodes[i * 3 + normal];
    if (pn < minN) minN = pn;
    if (pn > maxN) maxN = pn;
  }
  const epsilon = Math.max((maxN - minN) * 1e-4, 1e-15);
  const segments: Segment2D[] = [];
  let intersectionBounds: Bounds2D | null = null;
  let valueMin = Number.POSITIVE_INFINITY;
  let valueMax = Number.NEGATIVE_INFINITY;
  const addSegment = (pa: Point3, pb: Point3, va: number, vb: number) => {
    valueMin = Math.min(valueMin, va, vb);
    valueMax = Math.max(valueMax, va, vb);
    const a = project(pa, plane);
    const b = project(pb, plane);
    intersectionBounds = includePointInBounds(intersectionBounds, a);
    intersectionBounds = includePointInBounds(intersectionBounds, b);
    segments.push({ a, b, va, vb });
  };
  const edges = [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as const;
  for (let f = 0; f < numFaces; f++) {
    if (visibility?.visibleBoundaryFaces && visibility.visibleBoundaryFaces[f] !== 1) continue;
    const ia = flatFaces[f * 3];
    const ib = flatFaces[f * 3 + 1];
    const ic = flatFaces[f * 3 + 2];
    const p: [Point3, Point3, Point3] = [
      [flatNodes[ia * 3], flatNodes[ia * 3 + 1], flatNodes[ia * 3 + 2]],
      [flatNodes[ib * 3], flatNodes[ib * 3 + 1], flatNodes[ib * 3 + 2]],
      [flatNodes[ic * 3], flatNodes[ic * 3 + 1], flatNodes[ic * 3 + 2]],
    ];
    const values = [
      nodeScalar(meshData, ia, component),
      nodeScalar(meshData, ib, component),
      nodeScalar(meshData, ic, component),
    ] as const;
    const signed = [p[0][normal] - planeCoord, p[1][normal] - planeCoord, p[2][normal] - planeCoord] as const;
    const near = [Math.abs(signed[0]) <= epsilon, Math.abs(signed[1]) <= epsilon, Math.abs(signed[2]) <= epsilon] as const;
    if (near[0] && near[1] && near[2]) {
      addSegment(p[0], p[1], values[0], values[1]);
      addSegment(p[1], p[2], values[1], values[2]);
      addSegment(p[2], p[0], values[2], values[0]);
      continue;
    }
    const intersections: { point: Point3; value: number }[] = [];
    for (const [a, b] of edges) {
      const da = signed[a];
      const db = signed[b];
      const va = values[a];
      const vb = values[b];
      if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
        intersections.push({ point: p[a], value: va });
        intersections.push({ point: p[b], value: vb });
        continue;
      }
      if (Math.abs(da) <= epsilon) {
        intersections.push({ point: p[a], value: va });
        continue;
      }
      if (Math.abs(db) <= epsilon) {
        intersections.push({ point: p[b], value: vb });
        continue;
      }
      if (da * db < 0) {
        const t = da / (da - db);
        intersections.push({ point: lerpPoint(p[a], p[b], t), value: lerp(va, vb, t) });
      }
    }
    const unique = uniquePoints(intersections, epsilon);
    if (unique.length === 2) {
      addSegment(unique[0].point, unique[1].point, unique[0].value, unique[1].value);
    } else if (unique.length === 3) {
      unique.sort((lhs, rhs) => lhs.point[u] - rhs.point[u] || lhs.point[v] - rhs.point[v]);
      addSegment(unique[0].point, unique[1].point, unique[0].value, unique[1].value);
      addSegment(unique[1].point, unique[2].point, unique[1].value, unique[2].value);
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
    arrows: [],
    valueRange: finalizeRange(valueMin, valueMax, component),
  };
}

function collectTetraSegments(
  meshData: FemMeshData,
  plane: SlicePlane,
  component: VectorComponent,
  planeCoord: number,
  visibility: SliceVisibilityState | null,
  boundsStrategy: SliceBoundsStrategy,
): SliceCollection {
  const flatNodes = meshData.nodes;
  const flatElements = meshData.elements;
  const numNodes = flatNodes.length / 3;
  const numElements = flatElements.length / 4;
  const { normal, u, v } = axisIndices(plane);

  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < numNodes; i++) {
    const pn = flatNodes[i * 3 + normal];
    if (pn < minN) minN = pn;
    if (pn > maxN) maxN = pn;
  }
  const epsilon = Math.max((maxN - minN) * 1e-4, 1e-15);
  const polygons: Polygon2D[] = [];
  const arrows: SliceArrow2D[] = [];
  let intersectionBounds: Bounds2D | null = null;
  let valueMin = Number.POSITIVE_INFINITY;
  let valueMax = Number.NEGATIVE_INFINITY;
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
    const points = ids.map((nodeIndex) => [flatNodes[nodeIndex * 3], flatNodes[nodeIndex * 3 + 1], flatNodes[nodeIndex * 3 + 2]] as Point3) as [Point3, Point3, Point3, Point3];
    const values = ids.map((nodeIndex) => nodeScalar(meshData, nodeIndex, component)) as [number, number, number, number];
    const vectors = ids.map((nodeIndex) => nodeVector(meshData, nodeIndex)) as [Point3, Point3, Point3, Point3];
    const signed = points.map((point) => point[normal] - planeCoord) as [number, number, number, number];
    const intersections: { point: Point3; value: number; vector: Point3 }[] = [];
    for (const [a, b] of edges) {
      const da = signed[a];
      const db = signed[b];
      const va = values[a];
      const vb = values[b];
      const vecA = vectors[a];
      const vecB = vectors[b];
      if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
        intersections.push({ point: points[a], value: va, vector: vecA });
        intersections.push({ point: points[b], value: vb, vector: vecB });
        continue;
      }
      if (Math.abs(da) <= epsilon) {
        intersections.push({ point: points[a], value: va, vector: vecA });
        continue;
      }
      if (Math.abs(db) <= epsilon) {
        intersections.push({ point: points[b], value: vb, vector: vecB });
        continue;
      }
      if (da * db > 0) continue;
      const t = da / (da - db);
      intersections.push({
        point: lerpPoint(points[a], points[b], t),
        value: lerp(va, vb, t),
        vector: [
          lerp(vecA[0], vecB[0], t),
          lerp(vecA[1], vecB[1], t),
          lerp(vecA[2], vecB[2], t),
        ],
      });
    }
    const unique = sortIntersectionLoop(uniquePoints(intersections, epsilon), plane);
    if (unique.length < 3) continue;
    let avgValue = 0;
    let avgU = 0;
    let avgV = 0;
    let avgVectorU = 0;
    let avgVectorV = 0;
    const pts: Point2[] = [];
    let minVal = unique[0].value;
    let maxVal = unique[0].value;
    for (const entry of unique) {
      avgValue += entry.value;
      const projected = project(entry.point, plane);
      pts.push(projected);
      avgU += projected[0];
      avgV += projected[1];
      avgVectorU += entry.vector[u];
      avgVectorV += entry.vector[v];
      intersectionBounds = includePointInBounds(intersectionBounds, projected);
      if (entry.value < minVal) minVal = entry.value;
      if (entry.value > maxVal) maxVal = entry.value;
    }
    avgValue /= unique.length;
    avgU /= unique.length;
    avgV /= unique.length;
    avgVectorU /= unique.length;
    avgVectorV /= unique.length;
    valueMin = Math.min(valueMin, minVal);
    valueMax = Math.max(valueMax, maxVal);
    polygons.push({
      points: pts,
      value: avgValue,
      partId: visibility?.elementPartIds[elementIndex] ?? null,
    });
    arrows.push({
      origin: [avgU, avgV],
      vector: [avgVectorU, avgVectorV],
      magnitude: Math.hypot(avgVectorU, avgVectorV),
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
  return meshData.elements.length >= 4
    ? collectTetraSegments(meshData, plane, component, planeCoord, visibility, boundsStrategy)
    : collectBoundarySegments(meshData, plane, component, planeCoord, visibility, boundsStrategy);
}
