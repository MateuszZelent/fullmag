import { describe, expect, it } from "vitest";

import {
  formatViewport2DTooltipContent,
  resolveViewport2DTooltipPosition,
  type Viewport2DPolygonHover,
} from "./viewport2dHoverTooltip";

function hoverFixture(): Viewport2DPolygonHover {
  return {
    pointer: {
      viewportHeight: 400,
      viewportWidth: 600,
      viewportX: 100,
      viewportY: 120,
    },
    polygon: {
      bounds: { uMax: 2, uMin: 0, vMax: 3, vMin: 1 },
      centroid: { u: 1.234567, v: 2.345678 },
      parentElementId: 42,
      polygonIndex: 7,
      qualityValue: 0.123456,
      triangleCount: 2,
      triangleStart: 12,
      vertexEnd: 8,
      vertexStart: 4,
      visible: true,
      worldCentroid: [1, 2, 3],
    },
  };
}

describe("viewport2dHoverTooltip", () => {
  it("formats parent tetrahedron details for the hover tooltip", () => {
    const content = formatViewport2DTooltipContent(hoverFixture(), "skewness");

    expect(content.title).toBe("Parent tet 42");
    expect(content.rows).toEqual([
      { label: "skewness", value: "0.12346" },
      { label: "polygon", value: "7" },
      { label: "triangles", value: "2" },
      { label: "centroid", value: "1.2346, 2.3457" },
    ]);
  });

  it("places the tooltip near the pointer when there is room", () => {
    expect(resolveViewport2DTooltipPosition(hoverFixture().pointer)).toEqual({
      left: 112,
      top: 132,
    });
  });

  it("flips and clamps the tooltip near viewport edges", () => {
    expect(
      resolveViewport2DTooltipPosition({
        viewportHeight: 220,
        viewportWidth: 260,
        viewportX: 252,
        viewportY: 212,
      }),
    ).toEqual({ left: 20, top: 72 });
  });

  it("keeps the tooltip inside very small viewports", () => {
    expect(
      resolveViewport2DTooltipPosition({
        viewportHeight: 60,
        viewportWidth: 80,
        viewportX: 70,
        viewportY: 50,
      }),
    ).toEqual({ left: 8, top: 8 });
  });
});
