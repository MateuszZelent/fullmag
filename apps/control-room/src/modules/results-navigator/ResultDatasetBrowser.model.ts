import type { AnalysisResultDatasetManifestResource } from "@/kernel/api/apiTypes";
import { type ResultDatasetBrowserModel } from "./resultDatasetBrowserModel";
import { analysisResultSelectionRef, type AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";

export function resultDatasetItemSelection(
  manifest: AnalysisResultDatasetManifestResource,
  item: ResultDatasetBrowserModel["items"][number],
): AnalysisResultSelectionRef {
  return analysisResultSelectionRef({
    branchId: item.branchId ?? undefined,
    datasetId: manifest.dataset_id,
    datasetRevision: manifest.dataset_revision,
    displayIndex: item.displayIndex ?? undefined,
    fieldId: item.fieldId ?? undefined,
    fieldRef: item.fieldRef ?? undefined,
    focus: "item",
    itemId: item.itemId,
    itemKind: item.itemKindCode,
    ...(item.coordinateRefs ? { coordinates: item.coordinateRefs } : {}),
    runId: manifest.run_id,
    sampleId: item.sampleId,
    sampleIndex: item.sampleIndex ?? undefined,
    stageId: manifest.stage_id,
    fieldRevision: item.fieldRef?.field_revision ?? undefined,
  });
}
