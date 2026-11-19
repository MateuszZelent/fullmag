import { BufferAttribute, BufferGeometry } from "three";

import {
  cardinalAxisIndex,
  planeAxesForCardinalAxis,
  type Viewport3DPrimitiveObject,
} from "../viewport3dPrimitiveModel";

const CYLINDER_RADIAL_SEGMENTS = 32;
const SPHERE_WIDTH_SEGMENTS = 32;
const SPHERE_HEIGHT_SEGMENTS = 16;
const FEATURE_ANGLE_COSINE = Math.cos((1 * Math.PI) / 180);

/**
 * Builds display edges for an authored primitive. Analytic primitives and CSG
 * use their feature boundaries; arbitrary primitive surfaces keep only open
 * boundaries and non-coplanar edges, so tessellation diagonals stay hidden.
 */
export function buildPrimitiveWireframeGeometry(
  object: Viewport3DPrimitiveObject,
  surfaceGeometry: BufferGeometry,
): BufferGeometry | null {
  const preview = object.csgPreview;
  if (
    object.kind === "cylinder-cylinder-difference" &&
    preview?.kind === "cylinder-cylinder-difference"
  ) {
    const axisIndex = cardinalAxisIndex(preview.cylinderAxis);
    if (axisIndex === null) {
      return buildBoxEdges(preview.boundsSize) ?? buildSurfaceFeatureEdges(surfaceGeometry);
    }

    const planeAxes = planeAxesForCardinalAxis(axisIndex);
    const innerCenterX =
      preview.innerCenter[planeAxes[0]] - preview.outerCenter[planeAxes[0]];
    const innerCenterY =
      preview.innerCenter[planeAxes[1]] - preview.outerCenter[planeAxes[1]];
    if (
      !Number.isFinite(preview.outerRadius) ||
      !Number.isFinite(preview.innerRadius) ||
      !Number.isFinite(preview.outerHeight) ||
      preview.outerRadius <= 0 ||
      preview.innerRadius <= 0 ||
      preview.innerRadius >= preview.outerRadius ||
      preview.outerHeight <= 0 ||
      !Number.isFinite(innerCenterX) ||
      !Number.isFinite(innerCenterY)
    ) {
      return buildSurfaceFeatureEdges(surfaceGeometry);
    }

    return (
      buildExtrudedCapBoundaryGeometry(surfaceGeometry, axisIndex) ??
      buildSurfaceFeatureEdges(surfaceGeometry)
    );
  }

  if (
    object.kind === "box-cylinder-difference" &&
    preview?.kind === "box-cylinder-difference"
  ) {
    const axisIndex = cardinalAxisIndex(preview.cylinderAxis);
    if (axisIndex === null) {
      return buildBoxEdges(preview.boxSize) ?? buildSurfaceFeatureEdges(surfaceGeometry);
    }

    const planeAxes = planeAxesForCardinalAxis(axisIndex);
    const planeWidth = Math.max(preview.boxSize[planeAxes[0]], 1e-12);
    const planeHeight = Math.max(preview.boxSize[planeAxes[1]], 1e-12);
    const depth = Math.max(preview.boxSize[axisIndex], 1e-12);
    if (
      !preview.boxSize.every((value) => Number.isFinite(value) && value > 0) ||
      !Number.isFinite(preview.cylinderRadius) ||
      preview.cylinderRadius <= 0
    ) {
      return buildSurfaceFeatureEdges(surfaceGeometry);
    }

    const positions = buildExtrudedCapBoundaryPositions(surfaceGeometry, axisIndex);
    if (!positions) return buildSurfaceFeatureEdges(surfaceGeometry);
    appendBoxAxialEdges(positions, planeWidth / 2, planeHeight / 2, depth, axisIndex);
    return makeLineGeometry(positions);
  }

  if (object.kind === "sphere") {
    return buildSphereEdges(surfaceGeometry) ?? buildSurfaceFeatureEdges(surfaceGeometry);
  }
  if (object.kind === "cylinder") {
    return buildCylinderEdges(surfaceGeometry) ?? buildSurfaceFeatureEdges(surfaceGeometry);
  }
  if (object.kind === "box" || object.kind === "unsupported") {
    return buildBoxEdges(object.bounds.size) ?? buildSurfaceFeatureEdges(surfaceGeometry);
  }

  return buildSurfaceFeatureEdges(surfaceGeometry);
}

function buildBoxEdges(size: readonly [number, number, number]): BufferGeometry | null {
  if (!size.every((value) => Number.isFinite(value) && value > 0)) return null;
  const positions: number[] = [];
  appendBoxEdges(positions, [size[0] / 2, size[1] / 2, size[2] / 2]);
  return makeLineGeometry(positions);
}

function appendBoxEdges(
  positions: number[],
  halfExtents: readonly [number, number, number],
  axisIndex?: 0 | 1 | 2,
): void {
  const corners = Array.from({ length: 8 }, (_, mask) =>
    [0, 1, 2].map((axis) => (mask & (1 << axis) ? 1 : -1) * halfExtents[axis]) as [
      number,
      number,
      number,
    ],
  );
  for (let mask = 0; mask < corners.length; mask += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const bit = 1 << axis;
      if ((mask & bit) !== 0) continue;
      appendSegment(
        positions,
        mapExtrusionAxis(corners[mask], axisIndex),
        mapExtrusionAxis(corners[mask | bit], axisIndex),
      );
    }
  }
}

function buildCylinderEdges(surface: BufferGeometry): BufferGeometry | null {
  const position = surface.getAttribute("position");
  const radialSegments = geometryParameter(
    surface,
    "radialSegments",
    CYLINDER_RADIAL_SEGMENTS,
  );
  const heightSegments = geometryParameter(surface, "heightSegments", 1);
  const rowWidth = radialSegments + 1;
  if (
    !position ||
    position.itemSize < 3 ||
    position.count < rowWidth * (heightSegments + 1)
  ) {
    return null;
  }

  const positions: number[] = [];
  const pointAt = (row: number, column: number): [number, number, number] => {
    const index = row * rowWidth + column;
    return [position.getX(index), position.getY(index), position.getZ(index)];
  };
  for (const row of [0, heightSegments]) {
    const points = Array.from(
      { length: rowWidth },
      (_, column) => pointAt(row, column),
    );
    appendPolyline(positions, points, false);
  }
  // A sparse set of generator lines keeps a wireframe-only cylinder legible.
  const generatorCount = Math.min(8, radialSegments);
  for (let index = 0; index < generatorCount; index += 1) {
    const column = Math.floor((radialSegments * index) / generatorCount);
    for (let row = 0; row < heightSegments; row += 1) {
      appendSegment(positions, pointAt(row, column), pointAt(row + 1, column));
    }
  }
  return makeLineGeometry(positions);
}

function buildSphereEdges(surface: BufferGeometry): BufferGeometry | null {
  const position = surface.getAttribute("position");
  const widthSegments = geometryParameter(
    surface,
    "widthSegments",
    SPHERE_WIDTH_SEGMENTS,
  );
  const heightSegments = geometryParameter(
    surface,
    "heightSegments",
    SPHERE_HEIGHT_SEGMENTS,
  );
  const rowWidth = widthSegments + 1;
  if (
    !position ||
    position.itemSize < 3 ||
    position.count < rowWidth * (heightSegments + 1)
  ) {
    return null;
  }

  const positions: number[] = [];
  const pointAt = (row: number, column: number): [number, number, number] => {
    const index = row * rowWidth + column;
    return [position.getX(index), position.getY(index), position.getZ(index)];
  };

  // SphereGeometry is a 32 x 16 Y-axis grid. Select existing grid rows and
  // columns, so every segment lies on the rendered triangles' shared edges.
  const meridianCount = Math.min(8, widthSegments);
  for (let index = 0; index < meridianCount; index += 1) {
    const column = Math.floor((widthSegments * index) / meridianCount);
    const points = Array.from(
      { length: heightSegments + 1 },
      (_, row) => pointAt(row, column),
    );
    appendPolyline(positions, points, false);
  }
  const parallelCount = Math.min(7, Math.max(heightSegments - 1, 0));
  for (let index = 1; index <= parallelCount; index += 1) {
    const row = Math.round((heightSegments * index) / (parallelCount + 1));
    if (row <= 0 || row >= heightSegments) continue;
    const points = Array.from(
      { length: widthSegments + 1 },
      (_, column) => pointAt(row, column),
    );
    appendPolyline(positions, points, false);
  }
  return makeLineGeometry(positions);
}

function geometryParameter(
  surface: BufferGeometry,
  name: string,
  fallback: number,
): number {
  const parameters = (
    surface as BufferGeometry & { parameters?: Record<string, unknown> }
  ).parameters;
  const value = parameters?.[name];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function buildExtrudedCapBoundaryGeometry(
  surface: BufferGeometry,
  axisIndex: 0 | 1 | 2,
): BufferGeometry | null {
  const positions = buildExtrudedCapBoundaryPositions(surface, axisIndex);
  return positions ? makeLineGeometry(positions) : null;
}

/**
 * Extracts the boundary edges of the two planar caps from the rendered surface.
 * This preserves Three's actual endpoint selection after its contour winding and
 * duplicate-point merge, while excluding every coplanar triangulation diagonal.
 */
function buildExtrudedCapBoundaryPositions(
  surface: BufferGeometry,
  axisIndex: 0 | 1 | 2,
): number[] | null {
  const position = surface.getAttribute("position");
  if (!position || position.itemSize < 3 || position.count < 3) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const magnitude = [0, 0, 0];
  for (let index = 0; index < position.count; index += 1) {
    const point = [position.getX(index), position.getY(index), position.getZ(index)];
    for (let axis = 0; axis < 3; axis += 1) {
      if (!Number.isFinite(point[axis])) return null;
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
      magnitude[axis] = Math.max(magnitude[axis], Math.abs(point[axis]));
    }
  }
  const minDepth = min[axisIndex];
  const maxDepth = max[axisIndex];
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || minDepth >= maxDepth) {
    return null;
  }

  const tolerances = [0, 1, 2].map((axis) =>
    Math.max((max[axis] - min[axis]) * 1e-7, magnitude[axis] * 2e-7, 1e-30),
  );
  const pointAt = (index: number): [number, number, number] => [
    position.getX(index),
    position.getY(index),
    position.getZ(index),
  ];
  const pointKey = (point: readonly [number, number, number]) =>
    point.map((value, axis) => Math.round(value / tolerances[axis])).join(",");
  const caps = new Map<number, Map<string, {
    start: [number, number, number];
    end: [number, number, number];
    faces: number;
  }>>();
  const addCapEdge = (
    target: Map<string, { start: [number, number, number]; end: [number, number, number]; faces: number }>,
    start: [number, number, number],
    end: [number, number, number],
  ): void => {
    const startKey = pointKey(start);
    const endKey = pointKey(end);
    if (startKey === endKey) return;
    const key = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    const existing = target.get(key);
    if (existing) {
      existing.faces += 1;
    } else {
      target.set(key, { start, end, faces: 1 });
    }
  };
  const index = surface.index;
  const vertexIndex = (offset: number) => index ? index.getX(offset) : offset;
  const indexCount = index?.count ?? position.count;

  for (let triangle = 0; triangle + 2 < indexCount; triangle += 3) {
    const a = pointAt(vertexIndex(triangle));
    const b = pointAt(vertexIndex(triangle + 1));
    const c = pointAt(vertexIndex(triangle + 2));
    const depth = a[axisIndex];
    if (
      (depth !== minDepth && depth !== maxDepth) ||
      b[axisIndex] !== depth ||
      c[axisIndex] !== depth
    ) {
      continue;
    }
    let edges = caps.get(depth);
    if (!edges) {
      edges = new Map();
      caps.set(depth, edges);
    }
    addCapEdge(edges, a, b);
    addCapEdge(edges, b, c);
    addCapEdge(edges, c, a);
  }

  const result: number[] = [];
  for (const edges of caps.values()) {
    for (const edge of edges.values()) {
      if (edge.faces === 1) appendSegment(result, edge.start, edge.end);
    }
  }
  return result.length > 0 ? result : null;
}

function appendBoxAxialEdges(
  positions: number[],
  halfWidth: number,
  halfHeight: number,
  depth: number,
  axisIndex: 0 | 1 | 2,
): void {
  for (const signX of [-1, 1]) {
    for (const signY of [-1, 1]) {
      appendSegment(
        positions,
        mapExtrusionAxis([signX * halfWidth, signY * halfHeight, -depth / 2], axisIndex),
        mapExtrusionAxis([signX * halfWidth, signY * halfHeight, depth / 2], axisIndex),
      );
    }
  }
}

function appendPolyline(
  positions: number[],
  points: readonly [number, number, number][],
  closed: boolean,
): void {
  for (let index = 0; index + 1 < points.length; index += 1) {
    appendSegment(positions, points[index], points[index + 1]);
  }
  if (closed && points.length > 1) {
    appendSegment(positions, points[points.length - 1], points[0]);
  }
}

function appendSegment(
  positions: number[],
  start: readonly [number, number, number],
  end: readonly [number, number, number],
): void {
  positions.push(...start, ...end);
}

function mapExtrusionAxis(
  point: readonly [number, number, number],
  axisIndex: 0 | 1 | 2 = 2,
): [number, number, number] {
  if (axisIndex === 0) return [point[2], point[0], point[1]];
  if (axisIndex === 1) return [point[0], -point[2], point[1]];
  return [point[0], point[1], point[2]];
}

function buildSurfaceFeatureEdges(surface: BufferGeometry): BufferGeometry | null {
  const position = surface.getAttribute("position");
  if (!position || position.itemSize < 3 || position.count < 3) return null;

  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  const maxMagnitude = [0, 0, 0];
  for (let index = 0; index < position.count; index += 1) {
    const point = [position.getX(index), position.getY(index), position.getZ(index)];
    for (let axis = 0; axis < 3; axis += 1) {
      boundsMin[axis] = Math.min(boundsMin[axis], point[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], point[axis]);
      maxMagnitude[axis] = Math.max(maxMagnitude[axis], Math.abs(point[axis]));
    }
  }
  const tolerances = [0, 1, 2].map((axis) =>
    Math.max(
      (boundsMax[axis] - boundsMin[axis]) * 1e-7,
      maxMagnitude[axis] * 2e-7,
      1e-30,
    ),
  );
  const pointAt = (index: number): [number, number, number] => [
    position.getX(index),
    position.getY(index),
    position.getZ(index),
  ];
  const pointKey = (point: readonly [number, number, number]) =>
    point
      .map((value, axis) => Math.round(value / tolerances[axis]))
      .join(",");
  const edges = new Map<
    string,
    {
      start: [number, number, number];
      end: [number, number, number];
      firstNormal: [number, number, number];
      faces: number;
      feature: boolean;
    }
  >();
  const index = surface.index;
  const vertexIndex = (offset: number) =>
    index ? index.getX(offset) : offset;
  const indexCount = index?.count ?? position.count;
  const triangleCount = Math.floor(indexCount / 3);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = pointAt(vertexIndex(triangle * 3));
    const b = pointAt(vertexIndex(triangle * 3 + 1));
    const c = pointAt(vertexIndex(triangle * 3 + 2));
    const normal = triangleNormal(a, b, c);
    if (!normal) continue;
    addTriangleEdge(a, b, normal);
    addTriangleEdge(b, c, normal);
    addTriangleEdge(c, a, normal);
  }

  const output: number[] = [];
  for (const edge of edges.values()) {
    if (edge.faces === 1 || edge.feature) appendSegment(output, edge.start, edge.end);
  }
  return output.length > 0 ? makeLineGeometry(output) : null;

  function addTriangleEdge(
    start: [number, number, number],
    end: [number, number, number],
    normal: [number, number, number],
  ): void {
    const startKey = pointKey(start);
    const endKey = pointKey(end);
    if (startKey === endKey) return;
    const key = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, { start, end, firstNormal: normal, faces: 1, feature: false });
      return;
    }
    existing.faces += 1;
    const dot =
      existing.firstNormal[0] * normal[0] +
      existing.firstNormal[1] * normal[1] +
      existing.firstNormal[2] * normal[2];
    if (dot < FEATURE_ANGLE_COSINE) existing.feature = true;
  }
}

function triangleNormal(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): [number, number, number] | null {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const magnitude = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  return [nx / magnitude, ny / magnitude, nz / magnitude];
}

function makeLineGeometry(positions: readonly number[]): BufferGeometry | null {
  if (positions.length === 0 || positions.length % 6 !== 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(Float32Array.from(positions), 3));
  return geometry;
}
