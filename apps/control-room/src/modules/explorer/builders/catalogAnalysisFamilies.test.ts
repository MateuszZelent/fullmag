import { describe, expect, it } from "vitest";

import type { AnalysisResultDatasetSummaryResource } from "@/kernel/api/apiTypes";
import { analysisSurfaceForSelectionKind } from "@/kernel/analysis-modules/analysisSurfaceRouting";

import type { ExplorerNode } from "../explorerTypes";
import { withCatalogAnalysisFamilies } from "./resultsExplorerNodes";

const root: ExplorerNode = {
  analysisRunId: "run:1",
  availability: "unavailable",
  executionState: "not_started",
  id: "results:root",
  kind: "results.root",
  label: "Results",
  parentId: null,
  resourceState: "idle",
  status: "unavailable",
  children: [],
};

function dataset(
  productKind: AnalysisResultDatasetSummaryResource["product_kind"],
  stageId: string,
): AnalysisResultDatasetSummaryResource {
  return {
    dataset_id: `result:run:1:${stageId}:${productKind}`,
    dataset_revision: "r1",
    item_count: 0,
    manifest_resource_key: "manifest",
    product_kind: productKind,
    run_id: "run:1",
    sample_count: 1,
    stage_id: stageId,
    status: { completeness: "complete", execution: "published", qualification: "legacy", resource: "complete" },
    title: "Hysteresis loop",
  };
}

describe("catalog analysis families", () => {
  it("adds a hysteresis family owned by analysis.hysteresis", () => {
    const [results] = withCatalogAnalysisFamilies([root], [dataset("hysteresis_loop", "stage-001")]);
    const family = results?.children?.find((child) => child.kind === "results.hysteresis.root");
    expect(results?.availability).toBe("available");
    expect(family?.analysisModuleId).toBe("analysis.hysteresis");
    expect(family?.children?.[0]?.analysisStageId).toBe("stage-001");
    expect(analysisSurfaceForSelectionKind(family?.kind)).toBe("hysteresis");
  });

  it("adds a comparison node only when there is more than one source", () => {
    const single = withCatalogAnalysisFamilies([root], [dataset("hysteresis_loop", "stage-001")]);
    expect(single[0]?.children?.some((child) => child.kind === "results.frequency_domain.comparison")).toBe(false);
    const [results] = withCatalogAnalysisFamilies(
      [root],
      [dataset("hysteresis_loop", "stage-001"), dataset("modal_eigen", "stage-002")],
    );
    const comparison = results?.children?.find((child) => child.kind === "results.frequency_domain.comparison");
    expect(comparison?.badge).toBe("2 sources");
    expect(analysisSurfaceForSelectionKind(comparison?.kind)).toBe("comparison");
  });

  it("ignores datasets of other runs", () => {
    const other = { ...dataset("hysteresis_loop", "stage-001"), run_id: "run:2" };
    expect(withCatalogAnalysisFamilies([root], [other])[0]).toBe(root);
  });
});
