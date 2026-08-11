"use client";

import { useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { useAnalysisFieldOverlay } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  executeModeVisualizationPhase,
  ModeVisualizationViewControls,
} from "../ModeVisualizationInspectorPanel";
import { ModeVisualizationBreadcrumbs } from "./ModeVisualizationBreadcrumbs";
import {
  modeVisualizationSelectionRef,
} from "./ModeVisualizationOverviewPanel";

interface ModeVisualizationPhaseControlProps {
  disabled: boolean;
  onChange?: (value: string) => void;
  onSetPhase: (value: string) => void;
  phaseRad: string;
}

export function ModeVisualizationPhaseControl({
  disabled,
  onChange,
  onSetPhase,
  phaseRad,
}: ModeVisualizationPhaseControlProps) {
  const [phaseDraft, setPhaseDraft] = useState(phaseRad);

  return (
    <FieldRow
      label="Phase"
      unit="rad"
      value={
        <div className="fm-visualization-toggle-grid">
          <input
            aria-label="Mode visualization phase"
            className="fm-inspector-input"
            disabled={disabled}
            inputMode="decimal"
            step="any"
            type="number"
            value={phaseDraft}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setPhaseDraft(value);
              onChange?.(value);
            }}
          />
          <Button
            aria-label="Set mode visualization phase"
            disabled={disabled}
            size="sm"
            type="button"
            onClick={() => onSetPhase(phaseDraft)}
          >
            Set phase
          </Button>
        </div>
      }
    />
  );
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function ModeVisualizationViewPanel({ selection }: InspectorPanelProps) {
  const target = modeVisualizationSelectionRef(selection);
  const kernel = useKernel();
  const activeOverlay = useAnalysisFieldOverlay(kernel.analysisFieldOverlay);
  const activeTargetOverlay =
    target &&
    activeOverlay?.fieldId === target.fieldId &&
    activeOverlay.source === target.source
      ? activeOverlay
      : null;
  const overlayPhaseRad =
    finiteNumber(activeTargetOverlay?.visualizationPhaseRad) ??
    finiteNumber(activeTargetOverlay?.query.phase_rad) ??
    0;
  const setPhase = (draft: string) => {
    const phaseRad = finiteNumber(draft);
    if (!target || !activeTargetOverlay || phaseRad == null) return;
    void executeModeVisualizationPhase({
      kernel,
      sourceDetail: selection.kind ?? "mode-visualization.view",
      target,
      phaseRad,
    });
  };

  return (
    <div
      className="fm-inspector-panel"
      data-inspector-owner="mode-visualization.view"
    >
      <ModeVisualizationBreadcrumbs selection={selection} />
      <InspectorGroup title="Mode view">
        <FieldRow label="View semantics" value={target?.view ?? "active overlay view"} />
        {target ? (
          <ModeVisualizationPhaseControl
            key={`${target.fieldId}:${target.source}:${overlayPhaseRad}`}
            disabled={!activeTargetOverlay}
            onSetPhase={setPhase}
            phaseRad={String(overlayPhaseRad)}
          />
        ) : null}
      </InspectorGroup>
      <ModeVisualizationViewControls selection={selection} />
    </div>
  );
}
