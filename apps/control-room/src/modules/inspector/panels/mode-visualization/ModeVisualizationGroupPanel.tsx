"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  modeVisualizationSelectionRef,
  modeVisualizationSourceLabel,
} from "./ModeVisualizationOverviewPanel";
import { ModeVisualizationBreadcrumbs } from "./ModeVisualizationBreadcrumbs";

export function ModeVisualizationGroupPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.group"
    >
      <ModeVisualizationBreadcrumbs selection={selection} />
      <InspectorGroup title="Available fields">
        {target ? (
          <>
            <FieldRow label="Family" value={modeVisualizationSourceLabel(target)} />
            {(target.fieldIds ?? [target.fieldId]).map((fieldId, index) => (
              <FieldRow
                key={fieldId}
                label={`Field ${index + 1}`}
                value={fieldId}
              />
            ))}
          </>
        ) : (
          <p className="fm-inspector-empty">No mode field group selected.</p>
        )}
      </InspectorGroup>
    </div>
  );
}
