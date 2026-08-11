"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  FmrModalSpectrumInspectorContent,
  useFmrResultSummary,
} from "./FrequencyDomainResultInspectors";

export function FmrModalSpectrumInspectorPanel(props: InspectorPanelProps) {
  const summary = useFmrResultSummary(props);
  return <FmrModalSpectrumInspectorContent summary={summary} />;
}
