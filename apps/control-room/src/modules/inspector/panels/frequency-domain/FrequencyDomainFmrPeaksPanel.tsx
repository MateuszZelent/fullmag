"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  FmrPeaksInspectorContent,
  useFmrResultSummary,
} from "./FrequencyDomainResultInspectors";

export function FmrPeaksInspectorPanel(props: InspectorPanelProps) {
  const summary = useFmrResultSummary(props);
  return <FmrPeaksInspectorContent summary={summary} />;
}
