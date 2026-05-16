import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";

import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";

describe("MeshQualityStatisticsView", () => {
  it("renders quality histograms and worst elements without raw JSON", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        element_count: 24,
        gamma: {
          histogram: [{ count: 4, hi: 0.05, lo: 0 }],
          mean: 0.64,
          min: 0.12,
        },
        sicn: {
          histogram: [{ count: 8, hi: 1, lo: 0.9 }],
          mean: 0.82,
          min: 0.18,
          p05: 0.33,
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
    expect(html).toContain("Element 7");
    expect(html).toContain("Domain 1");
    expect(html).not.toContain("worst_elements");
  });
});
