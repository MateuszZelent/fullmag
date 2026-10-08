"use client";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import { useAnalysisFieldOverlayContext } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { AnalysisFieldOverlayContextNotice } from "@/kernel/visualization/AnalysisFieldOverlayContextNotice";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { ModeVisualizationViewControls } from "../ModeVisualizationInspectorPanel";
import {
  VisualizationTargetInspectorPanel,
  type VisualizationInspectorOwner,
} from "../ObjectVisualizationPanel";
import { ModeVisualizationBreadcrumbs } from "./ModeVisualizationBreadcrumbs";

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

export function ModeVisualizationOverviewPanel({
  selection,
}: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  const kernel = useKernel();
  const overlayContext = useAnalysisFieldOverlayContext(
    kernel.analysisFieldOverlay,
  );
  const commandContext = createCommandContext("inspector", kernel, {
    sourceDetail: "active-analysis-overlay-context",
  });
  const rebindCommand = kernel.commands.get(
    "analysis.frequency-domain.rebind-3d-overlay",
  );
  const rebindDisabledReason = rebindCommand
    ? rebindCommand.disabledReason?.(commandContext) ?? null
    : "Analysis overlay rebind command is unavailable.";
  // A mode is a quantity on the magnetic object, so the Inspector is the
  // object's visualization Inspector (same sections, icons and edit session)
  // with a mode owner and mode-only sections (spec 32 §12).
  const owner: VisualizationInspectorOwner = {
    actionSummary: "Complex representation, phase and the object's display passes, coloring and vectors",
    capabilityDescription: target
      ? `${modeVisualizationSourceLabel(target)} field shown as the viewport quantity on this object.`
      : "Published frequency-domain field shown as the viewport quantity.",
    id: "object.mode_visualization",
    targetLabel: target ? modeVisualizationSelectionLabel(target) : "Mode field",
    title: "Mode visualization",
  };
  return (
    <>
      <ModeVisualizationBreadcrumbs selection={selection} />
      <AnalysisFieldOverlayContextNotice
        context={overlayContext}
        onClear={() => {
          void kernel.commands.execute(
            "analysis.frequency-domain.clear-3d-overlay",
            commandContext,
          );
        }}
        onRebind={() => {
          void kernel.commands.execute(
            "analysis.frequency-domain.rebind-3d-overlay",
            commandContext,
          );
        }}
        rebindDisabledReason={rebindDisabledReason}
      />
      <VisualizationTargetInspectorPanel owner={owner} selection={selection}>
        <ModeVisualizationViewControls selection={selection} />
      </VisualizationTargetInspectorPanel>
    </>
  );
}
