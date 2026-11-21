import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { InspectorPanelProps } from "../../inspectorTypes";

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
  if (
    target.source === "frequency-response" &&
    target.frequencyIndex !== undefined
  ) {
    return `Frequency ${target.frequencyIndex}`;
  }
  if (target.sampleIndex !== undefined && target.modeIndex !== undefined) {
    return `Sample ${target.sampleIndex}, mode ${target.modeIndex}`;
  }
  return "Published field";
}
