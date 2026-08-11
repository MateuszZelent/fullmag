import type { SelectionRef } from "@/kernel/selection/selectionTypes";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

export type ModeVisualizationSelectionRef = Extract<
  SelectionRef,
  { type: "mode-visualization" }
>;

export function modeVisualizationSelectionRef(
  selection: InspectorPanelProps["selection"],
): ModeVisualizationSelectionRef | null {
  return selection.ref?.type === "mode-visualization" ? selection.ref : null;
}

export function modeVisualizationSourceLabel(
  target: ModeVisualizationSelectionRef,
): string {
  return target.source === "eigen-mode" ? "Eigenmode" : "Driven response";
}

export function modeVisualizationSelectionLabel(
  target: ModeVisualizationSelectionRef,
): string {
  if (target.source === "frequency-response" && target.frequencyIndex !== undefined) {
    return `Frequency ${target.frequencyIndex}`;
  }
  if (target.sampleIndex !== undefined && target.modeIndex !== undefined) {
    return `Sample ${target.sampleIndex}, mode ${target.modeIndex}`;
  }
  return "Published field";
}

export function ModeVisualizationOverviewPanel({
  selection,
}: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.overview"
    >
      <InspectorGroup title="Mode visualization overview">
        {target ? (
          <>
            <FieldRow label="Object" value={target.objectId} />
            <FieldRow label="Mode family" value={modeVisualizationSourceLabel(target)} />
            <FieldRow label="Selection" value={modeVisualizationSelectionLabel(target)} />
            <FieldRow label="Provenance" value="Frequency-domain result resources" />
          </>
        ) : (
          <p className="fm-inspector-empty">
            No mode visualization target selected.
          </p>
        )}
      </InspectorGroup>
    </div>
  );
}
