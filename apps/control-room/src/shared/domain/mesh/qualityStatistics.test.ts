import { describe, expect, it } from "vitest";

import { normalizeMeshQualityStatistics } from "./qualityStatistics";

describe("mesh quality statistics model", () => {
  it("normalizes backend SICN/gamma histograms and worst elements", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        characteristic_size: {
          histogram: [
            { count: 2, hi: 3e-9, lo: 1e-9 },
            { count: 22, hi: 9e-9, lo: 3e-9 },
          ],
          max: 9e-9,
          mean: 5e-9,
          min: 1e-9,
          ratio: 9,
          std: 1e-9,
        },
        edge_length: {
          histogram: [
            { count: 6, hi: 2e-9, lo: 1e-9 },
            { count: 18, hi: 4e-9, lo: 2e-9 },
          ],
          max: 4e-9,
          mean: 2e-9,
          min: 1e-9,
          std: 0.5e-9,
        },
        element_count: 24,
        gamma: {
          below_threshold_count: 2,
          below_threshold_fraction: 0.08333333333333333,
          histogram: [
            { count: 1, hi: 0.05, lo: 0 },
            { count: 3, hi: 0.1, lo: 0.05 },
          ],
          mean: 0.64,
          min: 0.12,
          threshold: 0.08,
        },
        sicn: {
          below_threshold_count: 3,
          below_threshold_fraction: 0.125,
          histogram: [
            { count: 0, hi: -0.9, lo: -1 },
            { count: 8, hi: 1, lo: 0.9 },
          ],
          max: 1,
          mean: 0.82,
          min: 0.18,
          p05: 0.33,
          threshold: 0.1,
        },
        volume: {
          histogram: [
            { count: 4, hi: 2e-27, lo: 1e-27 },
            { count: 20, hi: 4e-27, lo: 2e-27 },
          ],
          ratio: 42,
        },
        warnings: ["worst 5% SICN below quality target"],
      },
      mesh_name: "shared-domain",
      quality_source: "gmsh",
      worst_elements: [
        {
          element_index: 7,
          gamma: 0.12,
          centroid: [1, 2, 3],
          scope_label: "Domain 1",
          sicn: 0.18,
          volume: 2.4e-27,
        },
      ],
      worst_elements_by_metric: {
        gamma: [
          {
            element_index: 7,
            gamma: 0.12,
            centroid: [1, 2, 3],
            scope_label: "Domain 1",
            sicn: 0.18,
            volume: 2.4e-27,
          },
        ],
        sicn: [
          {
            element_index: 9,
            gamma: 0.4,
            centroid: [4, 5, 6],
            scope_label: "Domain 2",
            sicn: 0.05,
            volume: 3.4e-27,
          },
        ],
      },
    });

    expect(statistics).toMatchObject({
      elementCount: 24,
      edgeLength: { max: 4e-9, mean: 2e-9, min: 1e-9 },
      meshName: "shared-domain",
      metrics: [
        {
          belowThresholdCount: 3,
          belowThresholdFraction: 0.125,
          id: "sicn",
          min: 0.18,
          p05: 0.33,
          threshold: 0.1,
        },
        {
          belowThresholdCount: 2,
          belowThresholdFraction: 0.08333333333333333,
          id: "gamma",
          min: 0.12,
          p05: null,
          threshold: 0.08,
        },
      ],
      qualitySource: "gmsh",
      sizeDistributions: [
        {
          id: "tetra_size",
          max: 9e-9,
          mean: 5e-9,
          min: 1e-9,
          ratio: 9,
        },
        {
          id: "edge_length",
          max: 4e-9,
          mean: 2e-9,
          min: 1e-9,
        },
        {
          id: "volume",
          ratio: 42,
        },
      ],
      volumeRatio: 42,
      warnings: ["worst 5% SICN below quality target"],
      worstElements: [{ centroid: [1, 2, 3], elementIndex: 7, gamma: 0.12, sicn: 0.18 }],
      worstElementsByMetric: {
        gamma: [{ centroid: [1, 2, 3], elementIndex: 7, gamma: 0.12, sicn: 0.18 }],
        sicn: [{ centroid: [4, 5, 6], elementIndex: 9, gamma: 0.4, sicn: 0.05 }],
      },
    });
    expect(statistics?.metrics[0]?.histogram[1]).toMatchObject({
      count: 8,
      fraction: 1,
      label: "0.900 to 1.000",
    });
    expect(statistics?.sizeDistributions[0]?.histogram[0]).toMatchObject({
      count: 2,
      label: "1.00e-9 to 3.00e-9",
    });
    expect(statistics?.sizeDistributions[1]?.histogram[0]).toMatchObject({
      count: 6,
      label: "1.00e-9 to 2.00e-9",
    });
  });
});
