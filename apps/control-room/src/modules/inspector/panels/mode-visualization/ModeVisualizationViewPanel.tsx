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
  animate?: boolean;
  animationDirection?: -1 | 1;
  animationLoop?: boolean;
  animationRateHz?: number;
  disabled: boolean;
  onSetPhase: (value: string) => void;
  onAnimationChange?: (next: {
    animatePhase: boolean;
    animationRateHz: number;
    direction: -1 | 1;
    loop: boolean;
  }) => void;
  phaseRad: string;
}

export function ModeVisualizationPhaseControl({
  animate = false,
  animationDirection = 1,
  animationLoop = true,
  animationRateHz = 1,
  disabled,
  onSetPhase,
  onAnimationChange,
  phaseRad,
}: ModeVisualizationPhaseControlProps) {
  const [phaseDraft, setPhaseDraft] = useState(phaseRad);
  const [isPhaseEditing, setIsPhaseEditing] = useState(false);
  const numericPhaseValue = isPhaseEditing ? phaseDraft : phaseRad;

  return (
    <div className="fm-mode-phase-control">
      <FieldRow
        label="Phase"
        unit="rad"
        value={
          <div className="fm-mode-phase-control__value">
            <input
              aria-label="Mode visualization phase slider"
              className="fm-mode-phase-control__slider"
              disabled={disabled}
              max={Math.PI * 2}
              min="0"
              step="0.01"
              type="range"
              value={phaseRad}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onSetPhase(value);
              }}
            />
          <input
            aria-label="Mode visualization phase"
            className="fm-inspector-input"
            disabled={disabled}
            inputMode="decimal"
            step="any"
            type="number"
            value={numericPhaseValue}
            onBlur={() => setIsPhaseEditing(false)}
            onChange={(event) => {
              setPhaseDraft(event.currentTarget.value);
            }}
            onFocus={() => {
              setPhaseDraft(phaseRad);
              setIsPhaseEditing(true);
            }}
          />
          <Button
            aria-label="Set mode visualization phase"
            disabled={disabled}
            size="sm"
            type="button"
            onClick={() => {
              onSetPhase(numericPhaseValue);
              setIsPhaseEditing(false);
            }}
          >
            Set phase
          </Button>
          </div>
        }
      />
      <div className="fm-mode-phase-control__transport" role="group" aria-label="Mode phase animation">
        <Button
          aria-label={animate ? "Pause mode phase animation" : "Play mode phase animation"}
          disabled={disabled}
          size="sm"
          type="button"
          onClick={() => onAnimationChange?.({
            animatePhase: !animate,
            animationRateHz,
            direction: animationDirection,
            loop: animationLoop,
          })}
        >
          {animate ? "Pause" : "Play"}
        </Button>
        <select
          aria-label="Mode phase animation speed"
          className="fm-inspector-select"
          disabled={disabled}
          value={String(animationRateHz)}
          onChange={(event) => onAnimationChange?.({
            animatePhase: animate,
            animationRateHz: Number(event.currentTarget.value),
            direction: animationDirection,
            loop: animationLoop,
          })}
        >
          <option value="0.1">0.1 Hz</option>
          <option value="0.25">0.25 Hz</option>
          <option value="0.5">0.5 Hz</option>
          <option value="1">1 Hz</option>
          <option value="2">2 Hz</option>
        </select>
        <Button
          aria-label="Reverse mode phase animation"
          disabled={disabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onAnimationChange?.({
            animatePhase: animate,
            animationRateHz,
            direction: animationDirection === 1 ? -1 : 1,
            loop: animationLoop,
          })}
        >
          {animationDirection === 1 ? "Forward" : "Reverse"}
        </Button>
        <Button
          aria-label="Loop mode phase animation"
          aria-pressed={animationLoop}
          disabled={disabled}
          size="sm"
          type="button"
          variant={animationLoop ? "primary" : "secondary"}
          onClick={() => onAnimationChange?.({
            animatePhase: animate,
            animationRateHz,
            direction: animationDirection,
            loop: !animationLoop,
          })}
        >
          Loop
        </Button>
        <Button
          aria-label="Reset mode phase"
          disabled={disabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            setPhaseDraft("0");
            setIsPhaseEditing(false);
            onSetPhase("0");
          }}
        >
          Reset
        </Button>
      </div>
    </div>
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
            key={`${target.fieldId}:${target.source}`}
            disabled={!activeTargetOverlay}
            animate={activeTargetOverlay?.animation?.animatePhase ?? false}
            animationDirection={activeTargetOverlay?.animation?.direction ?? 1}
            animationLoop={activeTargetOverlay?.animation?.loop ?? true}
            animationRateHz={activeTargetOverlay?.animation?.animationRateHz ?? 1}
            onAnimationChange={(animation) => {
              kernel.analysisFieldOverlay.update({ animation });
            }}
            onSetPhase={setPhase}
            phaseRad={String(overlayPhaseRad)}
          />
        ) : null}
      </InspectorGroup>
      <ModeVisualizationViewControls selection={selection} />
    </div>
  );
}
