import { describe, expect, it } from "vitest";

import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "@/kernel/api/codecs";
import { buildCrossSectionQualityStatistics } from "@/shared/domain/mesh/crossSectionStatistics";

import {
  DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
  buildViewport2DRenderModel,
  resolveViewport2DQualityColor,
  resolveViewport2DPolygonHit,
} from "./viewport2dRenderModel";

function crossSectionFixture(): DecodedCrossSection {
  const vertexCount = 4;
  return {
    bounds: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
    ...intersectionMetadata(vertexCount),
    parentElementIds: new Uint32Array([7]),
    polygonCount: 1,
    polygonOffsets: new Uint32Array([0, 4]),
    segmentCount: 1,
    segments: new Float32Array([0, 0, 1, 0]),
    vertexCount,
    vertices: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  };
}

function qualityFixture(): DecodedCrossSectionQuality {
  return {
    perElementQuality: new Float32Array([0.2]),
    range: { min: 0, max: 1 },
  };
}

function twoPolygonCrossSectionFixture(): DecodedCrossSection {
  const vertexCount = 8;
  return {
    bounds: { uMin: 0, uMax: 4, vMin: 0, vMax: 2 },
    ...intersectionMetadata(
      vertexCount,
      new Float32Array([
        10, 20, 5,
        12, 20, 5,
        12, 22, 5,
        10, 22, 5,
        12, 20, 5,
        14, 20, 5,
        14, 22, 5,
        12, 22, 5,
      ]),
    ),
    parentElementIds: new Uint32Array([7, 8]),
    polygonCount: 2,
    polygonOffsets: new Uint32Array([0, 4, 8]),
    segmentCount: 2,
    segments: new Float32Array([0, 0, 2, 0, 2, 0, 4, 0]),
    vertexCount,
    vertices: new Float32Array([
      0, 0,
      2, 0,
      2, 2,
      0, 2,
      2, 0,
      4, 0,
      4, 2,
      2, 2,
    ]),
  };
}

function intersectionMetadata(
  vertexCount: number,
  intersectionWorld = new Float32Array(vertexCount * 3),
) {
  return {
    intersectionEdgeNodeIds: new Uint32Array(vertexCount * 2),
    intersectionEdgeT: new Float32Array(vertexCount),
    intersectionKinds: new Uint32Array(vertexCount),
    intersectionWorld,
  };
}

function twoPolygonQualityFixture(): DecodedCrossSectionQuality {
  return {
    perElementQuality: new Float32Array([0.2, 0.8]),
    range: { min: 0, max: 1 },
  };
}

describe("buildViewport2DRenderModel", () => {
  it("triangulates polygon fans and preserves wireframe segments", () => {
    const model = buildViewport2DRenderModel(
      crossSectionFixture(),
      qualityFixture(),
    );

    expect([...model.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...model.positions]).toEqual([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]);
    expect([...model.segments]).toEqual([0, 0, 1, 0]);
    expect(model.qualityRange).toEqual({ min: 0, max: 1 });
  });

  it("filters, shrinks, and hides wireframe from cross-section render options", () => {
    const model = buildViewport2DRenderModel(
      twoPolygonCrossSectionFixture(),
      twoPolygonQualityFixture(),
      {
        ...DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
        filterExpression: "quality < 0.3",
        shrinkFactor: 0.5,
        wireframeVisible: false,
      },
    );

    expect([...model.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...model.positions.slice(0, 12)]).toEqual([
      0.5, 0.5, 0,
      1.5, 0.5, 0,
      1.5, 1.5, 0,
      0.5, 1.5, 0,
    ]);
    expect(model.bounds).toEqual({ uMin: 0, uMax: 4, vMin: 0, vMax: 2 });
    expect(model.segments).toHaveLength(0);
  });

  it("applies saved frame rotation to 2D polygon and wireframe coordinates", () => {
    const model = buildViewport2DRenderModel(
      crossSectionFixture(),
      qualityFixture(),
      {
        ...DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
        frameRotationDegrees: 90,
      },
    );

    expectArrayClose([...model.positions], [
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
      0, 0, 0,
    ]);
    expectArrayClose([...model.segments], [1, 0, 1, 1]);
    expect(model.polygons[0].centroid.u).toBeCloseTo(0.5);
    expect(model.polygons[0].centroid.v).toBeCloseTo(0.5);
  });

  it("maps low and high quality values through the selected color scale", () => {
    const model = buildViewport2DRenderModel(
      twoPolygonCrossSectionFixture(),
      twoPolygonQualityFixture(),
      {
        ...DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
        colorScale: "jet",
      },
    );

    expect(model.colors[2]).toBeGreaterThan(model.colors[0]);
    expect(model.colors[12]).toBeGreaterThan(model.colors[14]);
  });

  it("exposes the same quality color mapping used by the polygon buffers", () => {
    const color = resolveViewport2DQualityColor(0.2, { min: 0, max: 1 }, "jet");

    expect([...color]).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(color[2]).toBeGreaterThan(color[0]);
  });

  it("records polygon metadata and maps rendered triangles back to parent elements", () => {
    const model = buildViewport2DRenderModel(
      twoPolygonCrossSectionFixture(),
      twoPolygonQualityFixture(),
    );

    expect([...model.trianglePolygonIndices]).toEqual([0, 0, 1, 1]);
    expect(model.polygons[0]).toMatchObject({
      centroid: { u: 1, v: 1 },
      parentElementId: 7,
      polygonIndex: 0,
      visible: true,
      worldCentroid: [11, 21, 5],
    });
    expect(model.polygons[0].qualityValue).toBeCloseTo(0.2);
    expect(model.polygons[1]).toMatchObject({
      centroid: { u: 3, v: 1 },
      parentElementId: 8,
      polygonIndex: 1,
      visible: true,
      worldCentroid: [13, 21, 5],
    });
    expect(model.polygons[1].qualityValue).toBeCloseTo(0.8);
    expect(resolveViewport2DPolygonHit(model, 2)).toMatchObject({
      parentElementId: 8,
      polygonIndex: 1,
    });
  });

  it("summarizes visible cross-section quality values for inspector readouts", () => {
    const model = buildViewport2DRenderModel(
      twoPolygonCrossSectionFixture(),
      twoPolygonQualityFixture(),
      {
        ...DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
        filterExpression: "quality < 0.3",
      },
    );

    const statistics = buildCrossSectionQualityStatistics(model.polygons, {
      histogramBinCount: 4,
      threshold: 0.3,
    });

    expect(statistics).toMatchObject({
      belowThresholdCount: 1,
      histogram: [
        { count: 1, label: "0.2 to 0.35" },
        { count: 0, label: "0.35 to 0.5" },
        { count: 0, label: "0.5 to 0.65" },
        { count: 0, label: "0.65 to 0.8" },
      ],
      polygonCount: 2,
      threshold: 0.3,
      visiblePolygonCount: 1,
    });
    expect(statistics.min).toBeCloseTo(0.2);
    expect(statistics.p05).toBeCloseTo(0.2);
    expect(statistics.mean).toBeCloseTo(0.2);
    expect(statistics.max).toBeCloseTo(0.2);
  });
});

function expectArrayClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index]);
  });
}
