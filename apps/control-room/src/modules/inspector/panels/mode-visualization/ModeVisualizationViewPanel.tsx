"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { ModeVisualizationViewControls } from "../ModeVisualizationInspectorPanel";
import { ModeVisualizationBreadcrumbs } from "./ModeVisualizationBreadcrumbs";
import {
  modeVisualizationSelectionRef,
} from "./ModeVisualizationOverviewPanel";

export function ModeVisualizationViewPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.view"
    >
      <ModeVisualizationBreadcrumbs selection={selection} />
      <InspectorGroup title="Mode view">
        <FieldRow label="View semantics" value={target?.view ?? "active overlay view"} />
        <FieldRow label="Phase" value="0 rad command default" />
      </InspectorGroup>
      <ModeVisualizationViewControls selection={selection} />
    </div>
  );
}
