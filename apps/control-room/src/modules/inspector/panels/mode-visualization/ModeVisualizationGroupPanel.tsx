import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  modeVisualizationSelectionRef,
  modeVisualizationSourceLabel,
} from "./ModeVisualizationOverviewPanel";

export function ModeVisualizationGroupPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.group"
    >
      <InspectorGroup title="Available fields">
        {target ? (
          <>
            <FieldRow label="Family" value={modeVisualizationSourceLabel(target)} />
            <FieldRow label={selection.label ?? "Published field"} value={target.fieldId} />
            <FieldRow
              label="Selection contract"
              value="Representative published field; full family remains in Explorer"
            />
          </>
        ) : (
          <p className="fm-inspector-empty">No mode field group selected.</p>
        )}
      </InspectorGroup>
    </div>
  );
}
