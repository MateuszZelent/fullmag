import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveViewport2DSelectedPolygon } from "./viewport2dSelectedPolygon";
import type {
  Viewport2DPolygonSummary,
  Viewport2DRenderModel,
} from "./viewport2dRenderModel";

function polygon(
  parentElementId: number,
  patch: Partial<Viewport2DPolygonSummary> = {},
): Viewport2DPolygonSummary {
  return {
    bounds: { uMax: 1, uMin: 0, vMax: 1, vMin: 0 },
    centroid: { u: 0.5, v: 0.5 },
    parentElementId,
    polygonIndex: parentElementId,
    qualityValue: 0.5,
    triangleCount: 2,
    triangleStart: 0,
    vertexEnd: 4,
    vertexStart: 0,
    visible: true,
    worldCentroid: [1, 2, 3],
    ...patch,
  };
}

function modelFixture(): Viewport2DRenderModel {
  return {
    bounds: { uMax: 1, uMin: 0, vMax: 1, vMin: 0 },
    colors: new Float32Array(),
    indices: new Uint32Array(),
    polygons: [polygon(7), polygon(8), polygon(9, { visible: false })],
    positions: new Float32Array(),
    qualityRange: null,
    segments: new Float32Array(),
    trianglePolygonIndices: new Uint32Array(),
  };
}

function selection(elementIndex: number): Pick<Selection, "ref"> {
  return {
    ref: {
      centroid: [1, 2, 3],
      elementIndex,
      kind: "mesh.quality.element",
      nodeId: `model:mesh:quality:cross-section:${elementIndex}`,
      type: "mesh-quality-element",
      visualizationTargetId: `mesh:quality:element:${elementIndex}`,
    },
  };
}

describe("resolveViewport2DSelectedPolygon", () => {
  it("maps a mesh-quality element selection back to a visible polygon", () => {
    expect(
      resolveViewport2DSelectedPolygon(modelFixture(), selection(8)),
    ).toMatchObject({
      parentElementId: 8,
      visible: true,
    });
  });

  it("ignores hidden polygons and unrelated selection refs", () => {
    expect(
      resolveViewport2DSelectedPolygon(modelFixture(), selection(9)),
    ).toBeNull();
    expect(
      resolveViewport2DSelectedPolygon(modelFixture(), { ref: null }),
    ).toBeNull();
  });
});
