import type { AnalysisResultDatasetManifestResource } from "@/kernel/api/apiTypes";
import { analysisResultSelectionRef, type AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";

export function resultSelectionForAnalysis(
  manifest: AnalysisResultDatasetManifestResource | null,
  selection: AnalysisResultSelectionRef | null,
): AnalysisResultSelectionRef | null {
  if (!manifest) return null;
  if (
    selection &&
    selection.runId === manifest.run_id &&
    selection.stageId === manifest.stage_id &&
    selection.datasetId === manifest.dataset_id &&
    selection.datasetRevision === manifest.dataset_revision
  ) {
    return selection;
  }
  return analysisResultSelectionRef({
    datasetId: manifest.dataset_id,
    datasetRevision: manifest.dataset_revision,
    focus: "dataset",
    runId: manifest.run_id,
    stageId: manifest.stage_id,
  });
}
