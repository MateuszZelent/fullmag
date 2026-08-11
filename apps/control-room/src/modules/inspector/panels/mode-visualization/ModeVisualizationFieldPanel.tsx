"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { buildModeFieldDiagnosticRows } from "../ModeVisualizationInspectorPanel";
import { ModeVisualizationBreadcrumbs } from "./ModeVisualizationBreadcrumbs";
import { modeVisualizationSelectionRef } from "./ModeVisualizationOverviewPanel";
import { useModeVisualizationFieldMetadata } from "./useModeVisualizationFieldMetadata";

export function ModeVisualizationFieldPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  const activeFieldMeta = useModeVisualizationFieldMetadata(target);

  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.field"
    >
      <ModeVisualizationBreadcrumbs selection={selection} />
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
