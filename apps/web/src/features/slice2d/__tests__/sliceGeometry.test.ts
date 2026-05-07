import { describe, it, expect } from "vitest";
import {
  pointInConvexPolygon,
  extractEdgesFromPolygons,
} from "@/components/preview/fem/femSliceGeometry";
import type { PolygonTopology2D } from "@/components/preview/fem/femSliceGeometry";

describe("pointInConvexPolygon", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  it("returns true for point inside", () => {
    expect(pointInConvexPolygon(0.5, 0.5, square)).toBe(true);
  });

  it("returns true for point on edge", () => {
    expect(pointInConvexPolygon(0.5, 0, square)).toBe(true);
  });

  it("returns true for point on vertex", () => {
    expect(pointInConvexPolygon(0, 0, square)).toBe(true);
  });

  it("returns false for point outside", () => {
    expect(pointInConvexPolygon(1.5, 0.5, square)).toBe(false);
    expect(pointInConvexPolygon(-0.1, 0.5, square)).toBe(false);
  });

  it("works with a triangle", () => {
    const triangle: [number, number][] = [
      [0, 0],
      [2, 0],
      [1, 2],
    ];
    expect(pointInConvexPolygon(1, 0.5, triangle)).toBe(true);
    expect(pointInConvexPolygon(0, 2, triangle)).toBe(false);
  });

  it("returns false for degenerate polygon (< 3 points)", () => {
    expect(pointInConvexPolygon(0, 0, [[0, 0], [1, 1]])).toBe(false);
    expect(pointInConvexPolygon(0, 0, [])).toBe(false);
  });
});

describe("extractEdgesFromPolygons", () => {
  it("extracts edges from a single triangle polygon", () => {
    const polygon: PolygonTopology2D = {
      points: [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
      worldPoints: [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, 1, 0],
      ],
      sampleRefs: [
        { kind: "node", nodeIndex: 0 },
        { kind: "node", nodeIndex: 1 },
        { kind: "node", nodeIndex: 2 },
      ],
      partId: "part-1",
    };
    const segments = extractEdgesFromPolygons([polygon]);
    expect(segments).toHaveLength(3);
    // Edge 0→1
    expect(segments[0].a).toEqual([0, 0]);
    expect(segments[0].b).toEqual([1, 0]);
    // Edge 1→2
    expect(segments[1].a).toEqual([1, 0]);
    expect(segments[1].b).toEqual([0.5, 1]);
    // Edge 2→0 (closing edge)
    expect(segments[2].a).toEqual([0.5, 1]);
    expect(segments[2].b).toEqual([0, 0]);
  });

  it("handles multiple polygons", () => {
    const quad: PolygonTopology2D = {
      points: [[0, 0], [1, 0], [1, 1], [0, 1]],
      worldPoints: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      sampleRefs: [
        { kind: "node", nodeIndex: 0 },
        { kind: "node", nodeIndex: 1 },
        { kind: "node", nodeIndex: 2 },
        { kind: "node", nodeIndex: 3 },
      ],
      partId: null,
    };
    const tri: PolygonTopology2D = {
      points: [[2, 0], [3, 0], [2.5, 1]],
      worldPoints: [[2, 0, 0], [3, 0, 0], [2.5, 1, 0]],
      sampleRefs: [
        { kind: "node", nodeIndex: 10 },
        { kind: "node", nodeIndex: 11 },
        { kind: "node", nodeIndex: 12 },
      ],
      partId: "p2",
    };
    const segments = extractEdgesFromPolygons([quad, tri]);
    // quad produces 4 edges, tri produces 3 edges
    expect(segments).toHaveLength(7);
  });

  it("returns empty for empty input", () => {
    expect(extractEdgesFromPolygons([])).toHaveLength(0);
  });
});
