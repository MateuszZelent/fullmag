import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";

import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";

describe("MeshQualityStatisticsView", () => {
  it("renders quality histograms and worst elements without raw JSON", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        element_count: 24,
        gamma: {
          below_threshold_count: 2,
          below_threshold_fraction: 0.08333333333333333,
          histogram: [{ count: 4, hi: 0.05, lo: 0 }],
          mean: 0.64,
          min: 0.12,
          threshold: 0.08,
        },
        sicn: {
          below_threshold_count: 3,
          below_threshold_fraction: 0.125,
          histogram: [{ count: 8, hi: 1, lo: 0.9 }],
          mean: 0.82,
          min: 0.18,
          p05: 0.33,
          threshold: 0.1,
        },
      },
      worst_elements: [{ element_index: 7, gamma: 0.12, scope_label: "Domain 1", sicn: 0.18 }],
    });

    const html = renderToStaticMarkup(
      <MeshQualityStatisticsView statistics={statistics} />,
    );

    expect(html).toContain("SICN");
    expect(html).toContain("Gamma");
    expect(html).toContain("Worst elements");
    expect(html).toContain("Below target");
    expect(html).toContain("3 / 24");
    expect(html).toContain("2 / 24");
    expect(html).toContain("Element 7");
    expect(html).toContain("Domain 1");
    expect(html).not.toContain("worst_elements");
  });

  it("renders worst elements as selection actions when a handler is provided", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        element_count: 24,
      },
      worst_elements: [{ element_index: 7, gamma: 0.12, scope_label: "Domain 1", sicn: 0.18 }],
    });

    const html = renderToStaticMarkup(
      <MeshQualityStatisticsView
        statistics={statistics}
        onSelectWorstElement={() => undefined}
      />,
    );

    expect(html).toContain("button");
    expect(html).toContain('data-element-index="7"');
  });

  it("renders metric heatmap actions when a metric handler is provided", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        element_count: 24,
        gamma: { histogram: [{ count: 4, hi: 0.05, lo: 0 }] },
        sicn: { histogram: [{ count: 8, hi: 1, lo: 0.9 }] },
      },
    });

    const html = renderToStaticMarkup(
      <MeshQualityStatisticsView
        statistics={statistics}
        onSelectMetric={() => undefined}
      />,
    );

    expect(html).toContain('data-metric-id="sicn"');
    expect(html).toContain('data-metric-id="gamma"');
    expect(html).toContain("Show heatmap");
  });

  it("renders quality refinement action when a local refinement plan is ready", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        edge_length: { mean: 4e-9 },
        element_count: 24,
        gamma: { min: 0.04 },
        sicn: { p05: 0.2 },
      },
      worst_elements: [
        {
          centroid: [1e-8, 2e-8, 3e-9],
          element_index: 7,
          gamma: 0.04,
          scope_label: "Domain 1",
          sicn: 0.2,
        },
      ],
    });

    const html = renderToStaticMarkup(
      <MeshQualityStatisticsView
        statistics={statistics}
        refinementState={resolveMeshQualityRefinementState(statistics)}
        onRefineWorstElement={() => undefined}
      />,
    );

    expect(html).toContain("Quality refinement");
    expect(html).toContain("Refine worst region");
    expect(html).toContain('data-element-index="7"');
  });
});
