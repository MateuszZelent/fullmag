"use client";

import { useMemo } from "react";

import { useModelCouplingsResource } from "@/kernel/resources/geometryLifecycleResources";
import { Accordion } from "@/shared/ui/Accordion";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import { resolveCouplingInspectorModel } from "./CouplingInspectorPanelModel";

function formatParameters(parameters: Record<string, unknown>): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return "none";
  return entries
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

export function CouplingInspectorPanel({ selection }: InspectorPanelProps) {
  const couplings = useModelCouplingsResource();
  const model = useMemo(
    () => resolveCouplingInspectorModel(selection, couplings.data ?? null),
    [couplings.data, selection],
  );

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={["identity", "endpoints", "parameters", "diagnostics"]}
    >
      <InspectorSection value="identity" title="Coupling" collapsible defaultCollapsed={false}>
        {model.mode === "missing" ? (
          <FeedbackBanner
            kind="warning"
            message="Selected coupling is not present in the current model resource."
          />
        ) : null}
        {model.mode === "unselected" ? (
          <FeedbackBanner kind="warning" message="No authored coupling selected." />
        ) : null}
        <FieldRow label="ID" value={model.couplingId ?? "none"} />
        <FieldRow label="Kind" value={model.kind} />
        <FieldRow label="Enabled" value={model.enabled ? "yes" : "no"} />
        <FieldRow label="Status" value={model.realizationStatus} />
      </InspectorSection>

      <InspectorSection value="endpoints" title="Endpoints">
        <FieldRow label="Source" value={model.source?.label ?? "unresolved"} />
        <FieldRow label="Source kind" value={model.source?.kind ?? "unresolved"} />
        <FieldRow label="Target" value={model.target?.label ?? "unresolved"} />
        <FieldRow label="Target kind" value={model.target?.kind ?? "unresolved"} />
      </InspectorSection>

      <InspectorSection value="parameters" title="Parameters">
        <FieldRow label="Values" value={formatParameters(model.parameters)} />
      </InspectorSection>

      <InspectorSection value="diagnostics" title="Diagnostics">
        <FieldRow
          label="Runtime policy"
          value={
            model.realizationStatus.includes("requires")
              ? "requires backend capability"
              : "authored intent"
          }
        />
      </InspectorSection>
    </Accordion>
  );
}
