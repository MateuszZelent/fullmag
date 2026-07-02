"use client";

import { useEffect, useMemo, useRef } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  DEFAULT_ANALYSIS_FIELD_VIEW,
  FrequencyDomainModeDisplayControls,
  analysisFieldViewLabel,
  normalizeAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "./FrequencyDomainModeDisplayControls";

type ModeVisualizationSelectionRef = Extract<
  SelectionRef,
  { type: "mode-visualization" }
>;

function modeVisualizationRef(
  selection: InspectorPanelProps["selection"],
): ModeVisualizationSelectionRef | null {
  return selection.ref?.type === "mode-visualization" ? selection.ref : null;
}

function modeVisualizationCommandId(ref: ModeVisualizationSelectionRef): string {
  return ref.source === "eigen-mode"
    ? "analysis.eigen.plot-mode-3d"
    : "analysis.frequency-response.plot-response-field-3d";
}

function modeVisualizationSourceLabel(ref: ModeVisualizationSelectionRef): string {
  return ref.source === "eigen-mode" ? "Eigenmode" : "Driven response";
}

function modeVisualizationIndexLabel(ref: ModeVisualizationSelectionRef): string {
  if (ref.source === "frequency-response" && ref.frequencyIndex !== undefined) {
    return `frequency ${ref.frequencyIndex}`;
  }
  if (ref.sampleIndex !== undefined && ref.modeIndex !== undefined) {
    return `sample ${ref.sampleIndex}, mode ${ref.modeIndex}`;
  }
  return "field";
}

export function ModeVisualizationInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const ref = modeVisualizationRef(selection);
  const kernel = useKernel();
  const sourceDetail = useMemo(
    () =>
      ref
        ? `Model object mode visualization ${ref.objectId} ${modeVisualizationIndexLabel(ref)}`
        : "Model object mode visualization",
    [ref],
  );
  const settings = useFrequencyDomainModeDisplaySettings({
    activation: ref
      ? {
          commandId: modeVisualizationCommandId(ref),
          fieldId: ref.fieldId,
          label: selection.label ?? modeVisualizationIndexLabel(ref),
          source: ref.source,
        }
      : undefined,
    sourceDetail,
  });
  const requestedView = normalizeAnalysisFieldView(
    ref?.view ?? settings.activeAnalysisFieldOverlay?.query.view,
  );
  const activationKey = ref
    ? `${ref.objectId}:${ref.source}:${ref.fieldId}:${requestedView}`
    : null;
  const lastActivationKey = useRef<string | null>(null);

  useEffect(() => {
    if (!ref || !activationKey) return;
    const overlay = settings.activeAnalysisFieldOverlay;
    if (
      overlay?.fieldId === ref.fieldId &&
      overlay.source === ref.source &&
      normalizeAnalysisFieldView(overlay.query.view) === requestedView
    ) {
      return;
    }
    if (lastActivationKey.current === activationKey) return;
    lastActivationKey.current = activationKey;
    void kernel.commands.execute(
      modeVisualizationCommandId(ref),
      createCommandContext("inspector", kernel, { sourceDetail }),
      {
        fieldId: ref.fieldId,
        label: selection.label ?? modeVisualizationIndexLabel(ref),
        phaseRad: 0,
        source: ref.source,
        view: requestedView,
      },
    );
  }, [
    activationKey,
    kernel,
    ref,
    requestedView,
    selection.label,
    settings.activeAnalysisFieldOverlay,
    sourceDetail,
  ]);

  if (!ref) {
    return (
      <InspectorSection title="Mode Visualization">
        <p className="fm-inspector-empty">No mode visualization target selected.</p>
      </InspectorSection>
    );
  }

  return (
    <InspectorSection title="Mode Visualization">
      <FieldRow label="Object" value={ref.objectId} />
      <FieldRow label="Source" value={modeVisualizationSourceLabel(ref)} />
      <FieldRow label="Selection" value={modeVisualizationIndexLabel(ref)} />
      <FieldRow label="Field" value={ref.fieldId} />
      <FieldRow
        label="Requested view"
        value={analysisFieldViewLabel(requestedView)}
      />
      <FrequencyDomainModeDisplayControls
        disabled={false}
        labelPrefix="Mode visualization"
        settings={settings}
        viewDefaultValue={ref.view ?? DEFAULT_ANALYSIS_FIELD_VIEW}
        viewOptions={ANALYSIS_FIELD_VIEW_OPTIONS}
      />
    </InspectorSection>
  );
}
