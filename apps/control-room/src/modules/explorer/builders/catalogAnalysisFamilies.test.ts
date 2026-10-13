import { describe, expect, it } from "vitest";

import type { AnalysisResultDatasetSummaryResource } from "@/kernel/api/apiTypes";
import { analysisSurfaceForSelectionKind } from "@/kernel/analysis-modules/analysisSurfaceRouting";

import { selectionRefFromNode } from "../explorerSelection";
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
    const datasetNode = family?.children?.[0];
    expect(results?.availability).toBe("available");
    expect(family?.analysisModuleId).toBe("analysis.hysteresis");
    expect(datasetNode).toMatchObject({
      analysisRunId: "run:1",
      analysisStageId: "stage-001",
      datasetId: "result:run:1:stage-001:hysteresis_loop",
      datasetRevision: "r1",
      kind: "results.hysteresis.dataset",
      studyProduct: "hysteresis_loop",
    });
    expect(analysisSurfaceForSelectionKind(family?.kind)).toBe("hysteresis");
    expect(analysisSurfaceForSelectionKind(datasetNode?.kind)).toBe("hysteresis");
    expect(selectionRefFromNode(datasetNode!)).toMatchObject({
      datasetId: "result:run:1:stage-001:hysteresis_loop",
      datasetRevision: "r1",
      focus: "dataset",
      kind: "analysis.result",
      runId: "run:1",
      stageId: "stage-001",
      type: "analysis-result",
    });
  });

  it("keeps same-stage hysteresis datasets separately addressable", () => {
    const first = {
      ...dataset("hysteresis_loop", "stage-shared"),
      dataset_id: "result:hysteresis:first",
    };
    const second = {
      ...dataset("hysteresis_loop", "stage-shared"),
      dataset_id: "result:hysteresis:second",
    };
    const [results] = withCatalogAnalysisFamilies([root], [first, second]);
    const family = results?.children?.find(
      (child) => child.kind === "results.hysteresis.root",
    );
    const [firstNode, secondNode] = family?.children ?? [];

    expect(firstNode?.id).not.toBe(secondNode?.id);
    expect(firstNode?.parentId).toBe(secondNode?.parentId);
    expect(selectionRefFromNode(firstNode!)).toMatchObject({
      datasetId: "result:hysteresis:first",
      focus: "dataset",
      type: "analysis-result",
    });
    expect(selectionRefFromNode(secondNode!)).toMatchObject({
      datasetId: "result:hysteresis:second",
      focus: "dataset",
      type: "analysis-result",
    });
  });

  it("joins legacy modal nodes only through their exact catalog run, stage and product", () => {
    const stage: ExplorerNode = {
      analysisRunId: "run:1",
      analysisStageId: "stage-modal",
      artifactRevision: "artifact-r9",
      children: [
        {
          analysisRunId: "run:1",
          analysisStageId: "stage-modal",
          artifactRevision: "artifact-r9",
          fieldId: "field:mode-1",
          id: "mode-1",
          kind: "results.dispersion.modal.mode_at_k",
          label: "Mode 1",
          parentId: "stage",
          studyProduct: "modal_eigen",
        },
      ],
      id: "stage",
      kind: "results.dispersion.modal.stage",
      label: "Modal stage",
      parentId: "results:root",
      studyProduct: "modal_eigen",
    };
    const catalogDataset = {
      ...dataset("modal_eigen", "stage-modal"),
      dataset_id: "catalog:mode-dataset",
      dataset_revision: "catalog-r3",
    };
    const [results] = withCatalogAnalysisFamilies(
      [{ ...root, children: [stage] }],
      [catalogDataset],
    );
    const mode = results?.children?.[0]?.children?.[0];

    expect(mode).toMatchObject({
      analysisStageId: "stage-modal",
      artifactRevision: "artifact-r9",
      datasetId: "catalog:mode-dataset",
      datasetRevision: "catalog-r3",
    });
  });

  it("leaves catalog identity absent when the run, stage and product join is ambiguous", () => {
    const mode: ExplorerNode = {
      analysisRunId: "run:1",
      analysisStageId: "stage-modal",
      artifactRevision: "legacy-r1",
      fieldId: "field:mode-1",
      id: "mode-1",
      kind: "results.dispersion.modal.mode_at_k",
      label: "Mode 1",
      parentId: "results:root",
      studyProduct: "modal_eigen",
    };
    const first = {
      ...dataset("modal_eigen", "stage-modal"),
      dataset_id: "catalog:mode-dataset-1",
    };
    const second = {
      ...dataset("modal_eigen", "stage-modal"),
      dataset_id: "catalog:mode-dataset-2",
    };
    const [results] = withCatalogAnalysisFamilies(
      [{ ...root, children: [mode] }],
      [first, second],
    );
    const joined = results?.children?.[0];

    expect(joined).toMatchObject({ analysisStageId: "stage-modal", artifactRevision: "legacy-r1" });
    expect(joined).not.toHaveProperty("datasetId");
    expect(joined).not.toHaveProperty("datasetRevision");
  });

  it("clears previously joined modal identity when the catalog match is no longer unique", () => {
    const mode: ExplorerNode = {
      analysisRunId: "run:1",
      analysisStageId: "stage-modal",
      artifactRevision: "legacy-r1",
      fieldId: "field:mode-1",
      id: "mode-1",
      kind: "results.dispersion.modal.mode_at_k",
      label: "Mode 1",
      parentId: "stage",
      studyProduct: "modal_eigen",
    };
    const stage: ExplorerNode = {
      analysisRunId: "run:1",
      analysisStageId: "stage-modal",
      children: [mode],
      id: "stage",
      kind: "results.dispersion.modal.stage",
      label: "Modal stage",
      parentId: "results:root",
      studyProduct: "modal_eigen",
    };
    const originalCatalog = {
      ...dataset("modal_eigen", "stage-modal"),
      dataset_id: "catalog:mode-dataset",
      dataset_revision: "catalog-r3",
    };
    const [initial] = withCatalogAnalysisFamilies(
      [{ ...root, children: [stage] }],
      [originalCatalog],
    );
    expect(initial?.children?.[0]?.children?.[0]).toMatchObject({
      datasetId: "catalog:mode-dataset",
      datasetRevision: "catalog-r3",
    });

    const ambiguousCatalog: AnalysisResultDatasetSummaryResource[] = [
      { ...originalCatalog, dataset_id: "catalog:mode-dataset-a" },
      { ...originalCatalog, dataset_id: "catalog:mode-dataset-b" },
    ];
    const changedCatalogs: AnalysisResultDatasetSummaryResource[][] = [
      [],
      [{ ...dataset("modal_eigen", "stage-modal"), run_id: "run:other" }],
      [dataset("modal_eigen", "other-stage")],
      ambiguousCatalog,
    ];
    for (const changedCatalog of changedCatalogs) {
      const [rejoined] = withCatalogAnalysisFamilies([initial!], changedCatalog);
      const changedMode = rejoined?.children?.[0]?.children?.[0];
      expect(changedMode).toMatchObject({
        analysisStageId: "stage-modal",
        artifactRevision: "legacy-r1",
      });
      expect(changedMode).not.toHaveProperty("datasetId");
      expect(changedMode).not.toHaveProperty("datasetRevision");
    }
  });

  it("clears catalog identity for FMR and eigen mode nodes when their run has no catalog entries", () => {
    const owners: ExplorerNode[] = [
      {
        analysisRunId: "run:1",
        analysisStageId: "stage-modal",
        datasetId: "stale:resonance",
        datasetRevision: "stale-r1",
        fieldId: "field:resonance-mode",
        id: "resonance-mode",
        kind: "results.resonance.modal.mode",
        label: "FMR mode",
        parentId: "results:root",
        studyProduct: "modal_eigen",
      },
      {
        analysisRunId: "run:1",
        analysisStageId: "stage-modal",
        datasetId: "stale:eigen",
        datasetRevision: "stale-r2",
        fieldId: "field:eigen-mode",
        id: "eigen-mode",
        kind: "results.eigen.mode",
        label: "Eigen mode",
        parentId: "results:root",
        studyProduct: "modal_eigen",
      },
    ];

    const [results] = withCatalogAnalysisFamilies([{ ...root, children: owners }], []);
    for (const owner of results?.children ?? []) {
      expect(owner).not.toHaveProperty("datasetId");
      expect(owner).not.toHaveProperty("datasetRevision");
    }
  });

  it("preserves explicit hysteresis dataset identity across frequency-domain joins", () => {
    const [initial] = withCatalogAnalysisFamilies(
      [root],
      [dataset("hysteresis_loop", "stage-hysteresis")],
    );
    const [rejoined] = withCatalogAnalysisFamilies(
      [initial!],
      [dataset("hysteresis_loop", "other-stage")],
    );
    const hysteresisDataset = rejoined?.children?.[0]?.children?.[0];

    expect(hysteresisDataset).toMatchObject({
      datasetId: "result:run:1:stage-hysteresis:hysteresis_loop",
      datasetRevision: "r1",
      kind: "results.hysteresis.dataset",
    });
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
