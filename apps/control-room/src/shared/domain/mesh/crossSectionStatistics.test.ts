import { describe, expect, it } from "vitest";

import {
  buildCrossSectionIntersectionStatistics,
  buildCrossSectionQualityStatistics,
} from "./crossSectionStatistics";

describe("buildCrossSectionQualityStatistics", () => {
  it("summarizes visible cross-section polygon qualities with stable histogram bins", () => {
    const statistics = buildCrossSectionQualityStatistics(
      [
        { qualityValue: 0.2, visible: true },
        { qualityValue: 0.8, visible: false },
      ],
      {
        histogramBinCount: 4,
        threshold: 0.3,
      },
    );

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

describe("buildCrossSectionIntersectionStatistics", () => {
  it("counts original mesh nodes separately from edge-plane intersections", () => {
    const statistics = buildCrossSectionIntersectionStatistics(
      new Uint32Array([0, 1, 1, 0, 0]),
    );

    expect(statistics).toEqual({
      edgeIntersectionCount: 3,
      meshNodeCount: 2,
      totalPointCount: 5,
    });
  });

  it("returns empty statistics for unavailable intersection metadata", () => {
    const statistics = buildCrossSectionIntersectionStatistics(null);

    expect(statistics).toEqual({
      edgeIntersectionCount: 0,
      meshNodeCount: 0,
      totalPointCount: 0,
    });
  });
});
