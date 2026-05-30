import { describe, expect, it } from "vitest";

import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "@/kernel/api/codecs";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import {
  DEFAULT_VIEWPORT_2D_METRIC,
  DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
  FALLBACK_VIEWPORT_2D_QUERY,
  buildViewport2DLoadState,
} from "./viewport2dLoadState";

interface ResourceSnapshot<TData> {
  data: TData | null;
  error: Error | null;
  status: ResourceStatus;
}

function resource<TData>(
  status: ResourceStatus,
  data: TData | null = null,
  error: Error | null = null,
): ResourceSnapshot<TData> {
  return { data, error, status };
}

function crossSectionFixture(): DecodedCrossSection {
  const vertexCount = 3;
  return {
    bounds: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
    intersectionEdgeNodeIds: new Uint32Array(vertexCount * 2),
    intersectionEdgeT: new Float32Array(vertexCount),
    intersectionKinds: new Uint32Array([0, 1, 0]),
    intersectionWorld: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    parentElementIds: new Uint32Array([42]),
    polygonCount: 1,
    polygonOffsets: new Uint32Array([0, 3]),
    segmentCount: 1,
    segments: new Float32Array([0, 0, 1, 0]),
    vertexCount,
    vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
  };
}

function qualityFixture(): DecodedCrossSectionQuality {
  return {
    perElementQuality: new Float32Array([0.2]),
    range: { min: 0, max: 1 },
  };
}

describe("buildViewport2DLoadState", () => {
  it("keeps the viewport unavailable until a cross-section plot is committed", () => {
    const state = buildViewport2DLoadState({
      crossSection: resource("loading"),
      hasActivePlot: false,
      metric: DEFAULT_VIEWPORT_2D_METRIC,
      quality: resource("loading"),
      query: FALLBACK_VIEWPORT_2D_QUERY,
      renderOptions: DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
    });

    expect(state).toEqual({
      message: "Create a 2D plot from the cross-section draft.",
      status: "unavailable",
    });
  });

  it("reports loading and error states before building render buffers", () => {
    expect(
      buildViewport2DLoadState({
        crossSection: resource("stale"),
        hasActivePlot: true,
        metric: DEFAULT_VIEWPORT_2D_METRIC,
        quality: resource("ready", qualityFixture()),
        query: FALLBACK_VIEWPORT_2D_QUERY,
        renderOptions: DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
      }),
    ).toEqual({ status: "loading" });

    expect(
      buildViewport2DLoadState({
        crossSection: resource("error", null, new Error("mesh missing")),
        hasActivePlot: true,
        metric: DEFAULT_VIEWPORT_2D_METRIC,
        quality: resource("loading"),
        query: FALLBACK_VIEWPORT_2D_QUERY,
        renderOptions: DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
      }),
    ).toEqual({ message: "mesh missing", status: "error" });
  });

  it("builds the mesh-section render model and statistics from ready resources", () => {
    const state = buildViewport2DLoadState({
      crossSection: resource("ready", crossSectionFixture()),
      hasActivePlot: true,
      metric: DEFAULT_VIEWPORT_2D_METRIC,
      quality: resource("ready", qualityFixture()),
      query: FALLBACK_VIEWPORT_2D_QUERY,
      renderOptions: DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
    });

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready state");
    expect([...state.model.indices]).toEqual([0, 1, 2]);
    expect(state.model.polygons[0]).toMatchObject({
      parentElementId: 42,
      triangleCount: 1,
      worldCentroid: [1 / 3, 1 / 3, 0],
    });
    expect(state.model.polygons[0].qualityValue).toBeCloseTo(0.2);
    expect(state.intersectionStatistics).toEqual({
      edgeIntersectionCount: 2,
      meshNodeCount: 1,
      totalPointCount: 3,
    });
    expect(state.statistics).toMatchObject({
      polygonCount: 1,
      threshold: 0.1,
      visiblePolygonCount: 1,
    });
  });

  it("still renders geometry when the quality payload is not applicable", () => {
    const state = buildViewport2DLoadState({
      crossSection: resource("ready", crossSectionFixture()),
      hasActivePlot: true,
      metric: DEFAULT_VIEWPORT_2D_METRIC,
      quality: resource("ready"),
      query: FALLBACK_VIEWPORT_2D_QUERY,
      renderOptions: DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
    });

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready state");
    expect(state.model.qualityRange).toBeNull();
    expect(state.model.polygons[0].qualityValue).toBeNull();
    expect(state.statistics.min).toBeNull();
  });
});
