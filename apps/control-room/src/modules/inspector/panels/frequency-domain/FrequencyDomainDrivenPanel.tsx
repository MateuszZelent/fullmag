"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  FmrResponseSweepInspectorContent,
  useFmrResultSummary,
} from "./FrequencyDomainResultInspectors";

export function FmrResponseSweepInspectorPanel(props: InspectorPanelProps) {
  const summary = useFmrResultSummary(props);
  return <FmrResponseSweepInspectorContent summary={summary} />;
}
