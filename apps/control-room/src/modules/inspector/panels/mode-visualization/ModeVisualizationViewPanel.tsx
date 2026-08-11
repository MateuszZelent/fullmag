"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { ModeVisualizationInspectorPanel } from "../ModeVisualizationInspectorPanel";
import {
  modeVisualizationSelectionLabel,
  modeVisualizationSelectionRef,
} from "./ModeVisualizationOverviewPanel";

export function ModeVisualizationViewPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.view"
    >
      <InspectorGroup title="Mode view">
        <FieldRow
          label="Selection"
          value={target ? modeVisualizationSelectionLabel(target) : "No view selected"}
        />
        <FieldRow label="View semantics" value={target?.view ?? "active overlay view"} />
      </InspectorGroup>
      <ModeVisualizationInspectorPanel selection={selection} />
    </div>
  );
}
