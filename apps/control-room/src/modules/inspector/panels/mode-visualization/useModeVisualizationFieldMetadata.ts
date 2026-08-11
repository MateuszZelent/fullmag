"use client";

import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainResponseFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";

import type { ModeVisualizationSelectionRef } from "./ModeVisualizationOverviewPanel";

export function useModeVisualizationFieldMetadata(
  target: ModeVisualizationSelectionRef | null,
) {
  const eigen = useFrequencyDomainEigenModeFieldMetaResource(
    target?.source === "eigen-mode" ? target.sampleIndex : null,
    target?.source === "eigen-mode" ? target.modeIndex : null,
    { enabled: target?.source === "eigen-mode" },
  );
  const response = useFrequencyDomainResponseFieldMetaResource(
    target?.source === "frequency-response" ? target.frequencyIndex : null,
    { enabled: target?.source === "frequency-response" },
  );
  return target?.source === "eigen-mode" ? eigen : response;
}
