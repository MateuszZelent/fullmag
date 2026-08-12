"use client";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import { useAnalysisFieldOverlayContext } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { AnalysisFieldOverlayContextNotice } from "@/kernel/visualization/AnalysisFieldOverlayContextNotice";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { ModeVisualizationViewControls } from "../ModeVisualizationInspectorPanel";
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
  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.overview"
    >
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
      <ModeVisualizationViewControls selection={selection} />
    </div>
  );
}
