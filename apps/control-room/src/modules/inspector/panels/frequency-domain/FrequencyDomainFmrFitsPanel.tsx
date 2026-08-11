"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  FmrKittelFitInspectorContent,
  FmrResonanceFitsInspectorContent,
  useFmrKittelFitSummary,
  useFmrResonanceFitsSummary,
} from "./FrequencyDomainResultInspectors";

export function FmrResonanceFitsInspectorPanel(props: InspectorPanelProps) {
  return (
    <FmrResonanceFitsInspectorContent
      summary={useFmrResonanceFitsSummary(props)}
    />
  );
}

export function FmrKittelFitInspectorPanel(props: InspectorPanelProps) {
  return (
    <FmrKittelFitInspectorContent summary={useFmrKittelFitSummary(props)} />
  );
}
