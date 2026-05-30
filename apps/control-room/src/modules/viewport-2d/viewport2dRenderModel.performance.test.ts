import { describe, expect, it } from "vitest";

import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "@/kernel/api/codecs";

import {
  DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
  buildViewport2DRenderModel,
} from "./viewport2dRenderModel";

const POLYGON_COUNT = 100_000;
const MAX_RENDER_MODEL_MS = Number(
  process.env.FULLMAG_VIEWPORT_2D_PERF_MAX_MS ?? "5000",
);

describe("viewport 2D cross-section render model performance", () => {
  it("builds a 100k-polygon render model without pathological runtime or buffer growth", () => {
    const crossSection = largeCrossSectionFixture(POLYGON_COUNT);
    const quality = largeQualityFixture(POLYGON_COUNT);
    const startedAt = performance.now();

    const model = buildViewport2DRenderModel(crossSection, quality, {
      ...DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
      colorScale: "viridis",
      frameRotationDegrees: 17,
      shrinkFactor: 0.92,
    });

    const durationMs = performance.now() - startedAt;
    console.info(
      `viewport-2d render model benchmark: polygons=${POLYGON_COUNT} durationMs=${durationMs.toFixed(2)}`,
    );

    expect(model.polygons).toHaveLength(POLYGON_COUNT);
    expect(model.indices).toHaveLength(POLYGON_COUNT * 6);
    expect(model.positions).toHaveLength(POLYGON_COUNT * 4 * 3);
    expect(model.colors).toHaveLength(POLYGON_COUNT * 4 * 3);
    expect(model.trianglePolygonIndices).toHaveLength(POLYGON_COUNT * 2);
    expect(durationMs).toBeLessThan(MAX_RENDER_MODEL_MS);
  });
});

function largeCrossSectionFixture(polygonCount: number): DecodedCrossSection {
  const vertexCount = polygonCount * 4;
  const columns = 500;
  const vertices = new Float32Array(vertexCount * 2);
  const polygonOffsets = new Uint32Array(polygonCount + 1);
  const parentElementIds = new Uint32Array(polygonCount);
  const intersectionWorld = new Float32Array(vertexCount * 3);
  const intersectionKinds = new Uint32Array(vertexCount);
  const intersectionEdgeT = new Float32Array(vertexCount);
  const intersectionEdgeNodeIds = new Uint32Array(vertexCount * 2);

  for (let polygon = 0; polygon < polygonCount; polygon += 1) {
    const column = polygon % columns;
    const row = Math.floor(polygon / columns);
    const vertexStart = polygon * 4;
    polygonOffsets[polygon] = vertexStart;
    parentElementIds[polygon] = polygon;
    writeQuad(vertices, vertexStart, column, row);
    for (let local = 0; local < 4; local += 1) {
      const vertex = vertexStart + local;
      intersectionWorld[vertex * 3] = vertices[vertex * 2];
      intersectionWorld[vertex * 3 + 1] = vertices[vertex * 2 + 1];
      intersectionKinds[vertex] = 1;
      intersectionEdgeT[vertex] = 0.5;
      intersectionEdgeNodeIds[vertex * 2] = vertex;
      intersectionEdgeNodeIds[vertex * 2 + 1] = vertex + 1;
    }
  }
  polygonOffsets[polygonCount] = vertexCount;

  return {
    bounds: {
      uMax: columns,
      uMin: 0,
      vMax: Math.ceil(polygonCount / columns),
      vMin: 0,
    },
    intersectionEdgeNodeIds,
    intersectionEdgeT,
    intersectionKinds,
    intersectionWorld,
    parentElementIds,
    polygonCount,
    polygonOffsets,
    segmentCount: 0,
    segments: new Float32Array(),
    vertexCount,
    vertices,
  };
}

function writeQuad(
  vertices: Float32Array,
  vertexStart: number,
  column: number,
  row: number,
): void {
  const base = vertexStart * 2;
  vertices[base] = column;
  vertices[base + 1] = row;
  vertices[base + 2] = column + 1;
  vertices[base + 3] = row;
  vertices[base + 4] = column + 1;
  vertices[base + 5] = row + 1;
  vertices[base + 6] = column;
  vertices[base + 7] = row + 1;
}

function largeQualityFixture(polygonCount: number): DecodedCrossSectionQuality {
  const perElementQuality = new Float32Array(polygonCount);
  for (let polygon = 0; polygon < polygonCount; polygon += 1) {
    perElementQuality[polygon] = (polygon % 1000) / 1000;
  }
  return {
    perElementQuality,
    range: { max: 1, min: 0 },
  };
}
