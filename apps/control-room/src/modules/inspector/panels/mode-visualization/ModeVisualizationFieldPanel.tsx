"use client";

import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainResponseFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { buildModeFieldDiagnosticRows } from "../ModeVisualizationInspectorPanel";
import { modeVisualizationSelectionRef } from "./ModeVisualizationOverviewPanel";

export function ModeVisualizationFieldPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  const eigenFieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    target?.source === "eigen-mode" ? target.sampleIndex : null,
    target?.source === "eigen-mode" ? target.modeIndex : null,
    { enabled: target?.source === "eigen-mode" },
  );
  const responseFieldMeta = useFrequencyDomainResponseFieldMetaResource(
    target?.source === "frequency-response" ? target.frequencyIndex : null,
    { enabled: target?.source === "frequency-response" },
  );
  const activeFieldMeta =
    target?.source === "eigen-mode" ? eigenFieldMeta : responseFieldMeta;

  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.field"
    >
      <InspectorGroup title="Field resource">
        {target ? (
          buildModeFieldDiagnosticRows({
            meta: activeFieldMeta.data ?? null,
            metaStatus: activeFieldMeta.status,
            target,
          }).map((row) => (
            <FieldRow key={row.label} label={row.label} value={row.value} />
          ))
        ) : (
          <p className="fm-inspector-empty">No mode field selected.</p>
        )}
      </InspectorGroup>
    </div>
  );
}
