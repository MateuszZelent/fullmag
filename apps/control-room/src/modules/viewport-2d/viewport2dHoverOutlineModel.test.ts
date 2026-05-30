import { describe, expect, it } from "vitest";

import { buildViewport2DHoverOutlineModel } from "./viewport2dHoverOutlineModel";
import type { Viewport2DPolygonSummary } from "./viewport2dRenderModel";

function polygonFixture(
  patch: Partial<Viewport2DPolygonSummary> = {},
): Viewport2DPolygonSummary {
  return {
    bounds: { uMax: 1, uMin: 0, vMax: 1, vMin: 0 },
    centroid: { u: 0.5, v: 0.5 },
    parentElementId: 7,
    polygonIndex: 0,
    qualityValue: 0.25,
    triangleCount: 2,
    triangleStart: 0,
    vertexEnd: 4,
    vertexStart: 0,
    visible: true,
    worldCentroid: [0.5, 0.5, 0],
    ...patch,
  };
}

describe("buildViewport2DHoverOutlineModel", () => {
  it("builds a closed line loop from hovered polygon vertices", () => {
    const outline = buildViewport2DHoverOutlineModel(
      {
        positions: new Float32Array([
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 1, 0,
        ]),
      },
      polygonFixture(),
    );

    expect(outline?.lineCount).toBe(4);
    expect([...(outline?.positions ?? [])]).toMatchObject([
      0, 0, expect.any(Number),
      1, 0, expect.any(Number),
      1, 0, expect.any(Number),
      1, 1, expect.any(Number),
      1, 1, expect.any(Number),
      0, 1, expect.any(Number),
      0, 1, expect.any(Number),
      0, 0, expect.any(Number),
    ]);
    expect(outline?.positions[2]).toBeCloseTo(0.04);
    expect(outline?.positions[23]).toBeCloseTo(0.04);
  });

  it("returns no outline for hidden or degenerate polygons", () => {
    expect(
      buildViewport2DHoverOutlineModel(
        { positions: new Float32Array([0, 0, 0, 1, 0, 0]) },
        polygonFixture({ visible: false }),
      ),
    ).toBeNull();
    expect(
      buildViewport2DHoverOutlineModel(
        { positions: new Float32Array([0, 0, 0]) },
        polygonFixture({ vertexEnd: 1 }),
      ),
    ).toBeNull();
  });
});
