import { describe, expect, it } from "vitest";

import { resolveViewport2DPolygonSelection } from "./viewport2dSelection";

describe("resolveViewport2DPolygonSelection", () => {
  it("maps a cross-section polygon to the existing mesh-quality element selection", () => {
    const selection = resolveViewport2DPolygonSelection(
      {
        bounds: { uMin: 2, uMax: 4, vMin: 0, vMax: 2 },
        centroid: { u: 3, v: 1 },
        parentElementId: 8,
        polygonIndex: 1,
        qualityValue: 0.8,
        triangleCount: 2,
        triangleStart: 2,
        vertexEnd: 8,
        vertexStart: 4,
        visible: true,
        worldCentroid: [13, 21, 5],
      },
      "gamma",
    );

    expect(selection).toEqual({
      kind: "mesh.cross-section",
      label: "Cross-section parent tet 8",
      nodeId: "model:mesh:quality:cross-section:8",
      objectId: null,
      ref: {
        centroid: [13, 21, 5],
        elementIndex: 8,
        kind: "mesh.quality.element",
        metric: "gamma",
        nodeId: "model:mesh:quality:cross-section:8",
        type: "mesh-quality-element",
        visualizationTargetId: "mesh:quality:element:8",
      },
    });
  });
});
