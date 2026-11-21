import type { InspectorPanelProps } from "../../inspectorTypes";
import { type FrequencyDomainSelectionContext } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH } from "@/kernel/api/apiPaths";

export function buildEigenDispersionPointHandoffContext(
  selection: InspectorPanelProps["selection"],
): FrequencyDomainSelectionContext {
  const ownerRef = selection.ref?.type === "frequency-domain"
    ? selection.ref
    : null;
  return {
    analysisRunId: ownerRef?.analysisRunId,
    analysisStageId: ownerRef?.analysisStageId,
    artifactPath: ownerRef?.artifactPath,
    artifactRevision: ownerRef?.artifactRevision,
    calculationMode: "dispersion_modal",
    datasetId: ownerRef?.datasetId,
    datasetRevision: ownerRef?.datasetRevision,
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  };
}
