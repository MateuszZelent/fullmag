import { describe, expect, it } from "vitest";

import { importedReferenceDefinition } from "@/kernel/analysis-modules/postprocessingDefinitions";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

import { selectionRefFromNode } from "@/modules/explorer/explorerSelection";

import { publishedReferenceDatasetRevision, referenceOverlaySeries } from "./referenceOverlaySeries";

const computed = [{
  id: "analysis.frequency-domain:eigen:dispersion:b1",
  label: "Branch 1",
  points: [{ rowIndex: 0, x: 0, y: 9.3 }],
  quantity: "frequency",
  source: { resourceKey: "dispersion", tableId: "dispersion" },
  status: "ready",
  unit: "GHz",
  xUnit: "rad/m",
}] as unknown as ChartSeries[];

const reference = importedReferenceDefinition({
  dataset: { artifactRevision: 7, runId: "run-1", stageId: "eigen" },
  fileName: "comsol.txt",
  label: "COMSOL sweep",
  points: [[-25e6, 13.68e9], [0, 9.32e9]],
  sourceUnits: { frequency: "GHz", path: "rad/um" },
});

describe("reference overlay series", () => {
  it("matches the published selection revision separately from the CSV digest", () => {
    const ref = selectionRefFromNode({
      id: "run-1:eigen:dispersion",
      kind: "results.dispersion.modal.relation",
      label: "Dispersion",
      parentId: null,
      analysisRunId: "run-1",
      analysisStageId: "eigen",
      artifactRevision: "dataset-r7",
    });
    if (ref?.type !== "frequency-domain" || ref.artifactRevision === undefined || !ref.analysisRunId || !ref.analysisStageId) {
      throw new Error("Published dispersion node must carry a dataset selection identity");
    }
    const imported = importedReferenceDefinition({
      dataset: { artifactRevision: ref.artifactRevision, runId: ref.analysisRunId, stageId: ref.analysisStageId },
      fileName: "comsol.txt",
      label: "COMSOL sweep",
      points: [[-25e6, 13.68e9], [0, 9.32e9]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });
    const identity = { runId: "run-1", stageId: "eigen" };
    const csvDigest = "csv-content-sha256";
    expect(imported.data_ref.dataset_revision).toBe("dataset-r7");
    expect(referenceOverlaySeries(computed, [imported], {
      ...identity, artifactRevision: publishedReferenceDatasetRevision({ revision: "dataset-r7" }),
    })).toHaveLength(1);
    expect(referenceOverlaySeries(computed, [imported], { ...identity, artifactRevision: csvDigest })).toEqual([]);
    expect(referenceOverlaySeries(computed, [imported], {
      ...identity, artifactRevision: publishedReferenceDatasetRevision({ revision: "dataset-r8" }),
    })).toEqual([]);
    for (const payload of [undefined, {}, { revision: " " }, { revision: 7 }]) {
      expect(referenceOverlaySeries(computed, [imported], {
        ...identity, artifactRevision: publishedReferenceDatasetRevision(payload),
      })).toEqual([]);
    }
  });

  it("draws imported references of the shown run in the computed unit", () => {
    const [series] = referenceOverlaySeries(computed, [reference], { artifactRevision: 7, runId: "run-1", stageId: "eigen" });
    expect(series).toMatchObject({ label: "COMSOL sweep (reference)", quantity: "reference_frequency", unit: "GHz" });
    expect(series?.points.map((point) => [point.x, point.y])).toEqual([[-25e6, 13.68], [0, 9.32]]);
  });

  it("does not overlay a reference on a republished or unidentified dataset", () => {
    expect(referenceOverlaySeries(computed, [reference], { artifactRevision: 8, runId: "run-1", stageId: "eigen" })).toEqual([]);
    expect(referenceOverlaySeries(computed, [reference], { artifactRevision: null, runId: "run-1", stageId: "eigen" })).toEqual([]);
    expect(referenceOverlaySeries(computed, [reference], { artifactRevision: "7", runId: "run-1", stageId: "eigen" })).toHaveLength(1);
  });

  it("ignores references of another run or stage", () => {
    expect(referenceOverlaySeries(computed, [reference], { artifactRevision: 7, runId: "run-2", stageId: "eigen" })).toEqual([]);
    expect(referenceOverlaySeries(computed, [reference], { artifactRevision: 7, runId: "run-1", stageId: "other" })).toEqual([]);
  });
});
