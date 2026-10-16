import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  frequencyDomainManifestPayload,
  frequencyDomainResultContextFromManifest,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

export function fmrModalSpectrumSelectionOwner(
  manifestResource: unknown,
  spectrumResource: unknown,
  selection?: InspectorPanelProps["selection"],
): { analysisRunId: string; analysisStageId: string } | null {
  const manifestOwner = frequencyDomainResultContextFromManifest(
    frequencyDomainManifestPayload(manifestResource),
  );
  const spectrum = record(spectrumResource);
  if (
    !manifestOwner.runId?.trim() ||
    !manifestOwner.stageId?.trim() ||
    spectrum?.run_id !== manifestOwner.runId ||
    spectrum?.stage_id !== manifestOwner.stageId
  ) {
    return null;
  }
  const ref = selection?.ref;
  const expectedOwner = ref?.type === "frequency-domain"
    ? { runId: ref.analysisRunId, stageId: ref.analysisStageId }
    : ref?.type === "analysis-result"
      ? { runId: ref.runId, stageId: ref.stageId }
      : null;
  if (expectedOwner && (
    expectedOwner.runId !== manifestOwner.runId ||
    expectedOwner.stageId !== manifestOwner.stageId
  )) return null;
  return {
    analysisRunId: manifestOwner.runId,
    analysisStageId: manifestOwner.stageId,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
