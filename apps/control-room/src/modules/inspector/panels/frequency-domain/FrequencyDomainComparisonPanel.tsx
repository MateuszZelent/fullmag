"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  FmrComparisonInspectorContent,
  useFmrComparisonSummary,
} from "./FrequencyDomainResultInspectors";

export function FmrComparisonInspectorPanel(props: InspectorPanelProps) {
  const summary = useFmrComparisonSummary(props);
  return <FmrComparisonInspectorContent summary={summary} />;
}
