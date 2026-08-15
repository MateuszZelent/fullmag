"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { VisualizationDebugPanel } from "../visualization-debug/VisualizationDebugPanel";
import { AirboxInspectorIdentityFrame } from "./AirboxInspectorIdentityFrame";
import {
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

function targetIdForSelection(selection: InspectorPanelProps["selection"]): string {
  return selection.ref?.type === "airbox"
    ? selection.ref.visualizationTargetId
    : "unresolved";
}

export function AirboxVisualizationDebugInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);

  return (
    <AirboxInspectorIdentityFrame
      lane={lane}
      owner="airbox.visualization.debug"
      selection={selection}
    >
      <div className="fm-airbox-visualization-debug-inspector">
        <InspectorGroup title="Airbox Visualization Debug" badge="diagnostic">
          <FieldRow label="Owner" value="airbox.visualization.debug" />
          <FieldRow
            label="Target"
            value={`Airbox target (${targetIdForSelection(selection)})`}
            mono
          />
          <FieldRow
            label="Capabilities"
            value="Airbox FEM viewport snapshots, field carriers, and exact transport metadata"
          />
          <FieldRow
            label="Actions"
            value="Inspect Airbox render adoption and export bounded evidence"
          />
        </InspectorGroup>
        <VisualizationDebugPanel selection={selection} />
      </div>
    </AirboxInspectorIdentityFrame>
  );
}
