import { describe, expect, it } from "vitest";

import type { BufferGeometry } from "three";

import type { Viewport3DPrimitiveObject } from "../viewport3dPrimitiveModel";
import {
  cardinalAxisIndex,
  planeAxesForCardinalAxis,
} from "../viewport3dPrimitiveModel";
import { createPrimitiveObjectGeometry } from "./PrimitiveObjectLayerModel";
import { buildPrimitiveWireframeGeometry } from "./primitiveWireframeGeometry";

type Vec3 = [number, number, number];
type CsgPreview = NonNullable<Viewport3DPrimitiveObject["csgPreview"]>;

function primitiveObject(
  kind: Viewport3DPrimitiveObject["kind"],
  size: Vec3,
  csgPreview: CsgPreview | null = null,
  center: Vec3 = [0, 0, 0],
): Viewport3DPrimitiveObject {
  return {
    bounds: {
      center,
      radius: Math.hypot(...size) / 2,
      size,
    },
    csgPreview,
    fallbackLabel: "primitive test",
    geometryKey: `primitive-test:${kind}`,
    kind,
    label: "Primitive test",
    magnetizationTexturePreview: null,
    meshState: "primitive-only",
    objectId: `primitive-test:${kind}`,
    sceneRevision: 1,
  };
}

function ringObject(scale: number, axis: Vec3): Viewport3DPrimitiveObject {
  const axisIndex = cardinalAxisIndex(axis);
  if (axisIndex === null) throw new Error("Test ring axis must be cardinal.");
  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const outerCenter: Vec3 = [11 * scale, -7 * scale, 23 * scale];
  const innerCenter: Vec3 = [...outerCenter];
  innerCenter[planeAxes[0]] += 7 * scale;
  innerCenter[planeAxes[1]] -= 5 * scale;
  const boundsSize: Vec3 = [300 * scale, 300 * scale, 300 * scale];
  boundsSize[axisIndex] = 50 * scale;

  return primitiveObject(
    "cylinder-cylinder-difference",
    boundsSize,
    {
      boundsSize,
      cylinderAxis: axis,
      innerCenter,
      innerHeight: 70 * scale,
      innerRadius: 50 * scale,
      kind: "cylinder-cylinder-difference",
      outerCenter,
      outerHeight: 50 * scale,
      outerRadius: 150 * scale,
    },
    outerCenter,
  );
}

function positionKey(geometry: BufferGeometry, index: number): string {
  const position = geometry.getAttribute("position");
  return `${position.getX(index)},${position.getY(index)},${position.getZ(index)}`;
}

function expectLineEndpointsOnSurface(
  surface: BufferGeometry,
  lines: BufferGeometry,
): void {
  const surfaceVertices = new Set<string>();
  const surfacePosition = surface.getAttribute("position");
  for (let index = 0; index < surfacePosition.count; index += 1) {
    surfaceVertices.add(positionKey(surface, index));
  }

  const missing: string[] = [];
  const linePosition = lines.getAttribute("position");
  for (let index = 0; index < linePosition.count; index += 1) {
    const key = positionKey(lines, index);
    if (!surfaceVertices.has(key)) missing.push(key);
  }
  expect(missing).toEqual([]);
}

function expectLineSegmentsOnSurfaceEdges(
  surface: BufferGeometry,
  lines: BufferGeometry,
): void {
  const surfacePosition = surface.getAttribute("position");
  const surfaceIndex = surface.index;
  const indexCount = surfaceIndex?.count ?? surfacePosition.count;
  const surfaceEdges = new Set<string>();
  const surfaceVertexKey = (offset: number) =>
    positionKey(surface, surfaceIndex ? surfaceIndex.getX(offset) : offset);
  const addSurfaceEdge = (start: string, end: string) =>
    surfaceEdges.add(start < end ? `${start}|${end}` : `${end}|${start}`);

  for (let offset = 0; offset + 2 < indexCount; offset += 3) {
    const a = surfaceVertexKey(offset);
    const b = surfaceVertexKey(offset + 1);
    const c = surfaceVertexKey(offset + 2);
    addSurfaceEdge(a, b);
    addSurfaceEdge(b, c);
    addSurfaceEdge(c, a);
  }

  const linePosition = lines.getAttribute("position");
  const missing: string[] = [];
  for (let offset = 0; offset + 1 < linePosition.count; offset += 2) {
    const start = positionKey(lines, offset);
    const end = positionKey(lines, offset + 1);
    const key = start < end ? `${start}|${end}` : `${end}|${start}`;
    if (!surfaceEdges.has(key)) missing.push(key);
  }
  expect(missing).toEqual([]);
}

function expectRingLoopDimensions(
  edges: BufferGeometry,
  axis: Vec3,
  scale: number,
): void {
  const axisIndex = cardinalAxisIndex(axis)!;
  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const position = edges.getAttribute("position");
  const loops = [
    { radius: 150 * scale, depth: axisIndex === 1 ? 25 * scale : -25 * scale, centerX: 0, centerY: 0 },
    { radius: 50 * scale, depth: axisIndex === 1 ? 25 * scale : -25 * scale, centerX: 7 * scale, centerY: -5 * scale },
    { radius: 150 * scale, depth: axisIndex === 1 ? -25 * scale : 25 * scale, centerX: 0, centerY: 0 },
    { radius: 50 * scale, depth: axisIndex === 1 ? -25 * scale : 25 * scale, centerX: 7 * scale, centerY: -5 * scale },
  ];
  const endpointCounts = [0, 0, 0, 0];
  let maxRadiusError = 0;
  let maxDepthError = 0;

  for (let index = 0; index < position.count; index += 1) {
    const point = [position.getX(index), position.getY(index), position.getZ(index)];
    const candidates = loops.map((loop) => {
      const radius = Math.hypot(
        point[planeAxes[0]] - loop.centerX,
        point[planeAxes[1]] - loop.centerY,
      );
      return {
        radius,
        distance: Math.abs(point[axisIndex] - loop.depth) + Math.abs(radius - loop.radius),
      };
    });
    const loopIndex = candidates.reduce(
      (best, candidate, candidateIndex) =>
        candidate.distance < candidates[best].distance ? candidateIndex : best,
      0,
    );
    const loop = loops[loopIndex];
    const loopRadius = candidates[loopIndex].radius;
    endpointCounts[loopIndex] += 1;
    maxRadiusError = Math.max(maxRadiusError, Math.abs(loopRadius - loop.radius));
    maxDepthError = Math.max(maxDepthError, Math.abs(point[axisIndex] - loop.depth));
  }

  expect(endpointCounts).toEqual([256, 256, 256, 256]);
  expect(maxRadiusError).toBeLessThan(scale * 1e-4);
  expect(maxDepthError).toBeLessThan(scale * 1e-4);
}

describe("primitive wireframe geometry", () => {
  it("matches eccentric annulus rims to CSG vertices across axes and SI scales", () => {
    for (const scale of [1e-9, 1e-6, 1]) {
      for (const axis of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] satisfies Vec3[]) {
        const object = ringObject(scale, axis);
        const surface = createPrimitiveObjectGeometry(object);
        const edges = buildPrimitiveWireframeGeometry(object, surface);
        expect(edges).not.toBeNull();
        expect(edges!.getAttribute("position").count).toBe(4 * 128 * 2);
        expectLineEndpointsOnSurface(surface, edges!);
        expectLineSegmentsOnSurfaceEdges(surface, edges!);
        expectRingLoopDimensions(edges!, axis, scale);
        surface.dispose();
        edges!.dispose();
      }
    }
  });

  it("keeps box and hole rims on the tessellated CSG surface", () => {
    for (const scale of [1e-9, 1]) {
      for (const axis of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] satisfies Vec3[]) {
        const axisIndex = cardinalAxisIndex(axis)!;
        const boxSize: Vec3 = [20 * scale, 30 * scale, 40 * scale];
        const center: Vec3 = [0, 0, 0];
        const planeAxes = planeAxesForCardinalAxis(axisIndex);
        center[planeAxes[0]] = 2 * scale;
        center[planeAxes[1]] = -3 * scale;
        const object = primitiveObject("box-cylinder-difference", boxSize, {
          boxSize,
          cylinderAxis: axis,
          cylinderCenter: center,
          cylinderHeight: boxSize[axisIndex],
          cylinderRadius: 4 * scale,
          kind: "box-cylinder-difference",
        });
        const surface = createPrimitiveObjectGeometry(object);
        const edges = buildPrimitiveWireframeGeometry(object, surface);
        expect(edges).not.toBeNull();
        expect(edges!.getAttribute("position").count).toBe(12 * 2 + 2 * 128 * 2);
        expectLineEndpointsOnSurface(surface, edges!);
        expectLineSegmentsOnSurfaceEdges(surface, edges!);
        surface.dispose();
        edges!.dispose();
      }
    }
  });

  it("uses the rendered Y-axis sphere grid at nanometre and metre scales", () => {
    for (const scale of [1e-9, 1]) {
      const object = primitiveObject("sphere", [6 * scale, 8 * scale, 10 * scale]);
      const surface = createPrimitiveObjectGeometry(object);
      const edges = buildPrimitiveWireframeGeometry(object, surface);
      expect(edges).not.toBeNull();
      expect(edges!.getAttribute("position").count).toBe(8 * 16 * 2 + 7 * 32 * 2);
      expectLineEndpointsOnSurface(surface, edges!);
      expectLineSegmentsOnSurfaceEdges(surface, edges!);
      surface.dispose();
      edges!.dispose();
    }
  });

  it("uses cylinder surface rows for cap rims and sparse generators", () => {
    for (const scale of [1e-9, 1]) {
      const object = primitiveObject("cylinder", [6 * scale, 6 * scale, 10 * scale]);
      const surface = createPrimitiveObjectGeometry(object);
      const edges = buildPrimitiveWireframeGeometry(object, surface);
      expect(edges).not.toBeNull();
      expect(edges!.getAttribute("position").count).toBe(2 * 32 * 2 + 8 * 2);
      expectLineEndpointsOnSurface(surface, edges!);
      expectLineSegmentsOnSurfaceEdges(surface, edges!);
      surface.dispose();
      edges!.dispose();
    }
  });
});
