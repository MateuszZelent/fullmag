"use client";

import { Play, Waves } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainResponseFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { useAnalysisFieldOverlay } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";
import { useVisualizationViewContext } from "../visualization/VisualizationContextSwitch";
import {
  analysisFieldViewOptions,
  canPlotSelectedFieldIn3D,
  selectedField3DPlotStatus,
} from "./frequency-domain/FrequencyDomainHelpers";
import {
  DEFAULT_ANALYSIS_FIELD_VIEW,
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

function modeVisualizationCommandId(
  target: Pick<ModeVisualizationSelectionRef, "source">,
): string {
  return target.source === "eigen-mode"
    ? "analysis.eigen.plot-mode-3d"
    : "analysis.frequency-response.plot-response-field-3d";
}

function modeVisualizationPhaseCommandId(
  target: Pick<ModeVisualizationSelectionRef, "source">,
): string {
  return target.source === "eigen-mode"
    ? "analysis.eigen.set-mode-3d-phase"
    : "analysis.frequency-domain.set-3d-phase";
}

const PHASE_MIN_RAD = 0;
/** Visual playback rates; they never change the physical mode frequency. */
const PHASE_ANIMATION_RATES_HZ = [0.1, 0.25, 0.5, 1, 2] as const;
const PHASE_MAX_RAD = Math.PI * 2;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPhaseRad(value: number): number {
  return Math.min(PHASE_MAX_RAD, Math.max(PHASE_MIN_RAD, value));
}

function normalizedPhaseValue(value: string): string | null {
  const phaseRad = finiteNumber(value);
  return phaseRad === null ? null : String(clampPhaseRad(phaseRad));
}

function isSetPhaseControl(target: EventTarget | null): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    "getAttribute" in target &&
    typeof target.getAttribute === "function" &&
    target.getAttribute("aria-label") === "Set mode visualization phase"
  );
}

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
  const committedPhaseValue =
    normalizedPhaseValue(phaseRad) ?? String(PHASE_MIN_RAD);
  const numericPhaseValue = isPhaseEditing ? phaseDraft : committedPhaseValue;
  const commitPhase = (draft: string) => {
    const normalized = normalizedPhaseValue(draft);
    if (normalized !== null) onSetPhase(normalized);
    setIsPhaseEditing(false);
  };

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
              max={PHASE_MAX_RAD}
              min={PHASE_MIN_RAD}
              step="0.01"
              type="range"
              value={committedPhaseValue}
              onChange={(event) => commitPhase(event.currentTarget.value)}
            />
            <input
              aria-label="Mode visualization phase"
              className="fm-inspector-input"
              disabled={disabled}
              inputMode="decimal"
              max={PHASE_MAX_RAD}
              min={PHASE_MIN_RAD}
              step="any"
              type="number"
              value={numericPhaseValue}
              onBlur={(event) => {
                if (!isSetPhaseControl(event.relatedTarget)) {
                  setPhaseDraft(committedPhaseValue);
                }
                setIsPhaseEditing(false);
              }}
              onChange={(event) => setPhaseDraft(event.currentTarget.value)}
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
              onClick={() => commitPhase(phaseDraft)}
            >
              Set phase
            </Button>
          </div>
        }
      />
      <div
        aria-label="Mode phase animation"
        className="fm-mode-phase-control__transport"
        role="group"
      >
        <Button
          aria-label={
            animate ? "Pause mode phase animation" : "Play mode phase animation"
          }
          disabled={disabled}
          size="sm"
          type="button"
          onClick={() =>
            onAnimationChange?.({
              animatePhase: !animate,
              animationRateHz,
              direction: animationDirection,
              loop: animationLoop,
            })
          }
        >
          {animate ? "Pause" : "Play"}
        </Button>
        <SegmentedControl
          aria-label="Mode phase animation speed"
          disabled={disabled}
          options={PHASE_ANIMATION_RATES_HZ.map((rate) => ({
            accessibleLabel: `${rate} visual cycles per second`,
            label: `${rate} Hz`,
            value: String(rate),
          }))}
          value={String(animationRateHz)}
          onValueChange={(value) =>
            onAnimationChange?.({
              animatePhase: animate,
              animationRateHz: Number(value),
              direction: animationDirection,
              loop: animationLoop,
            })
          }
        />
        <Button
          aria-label={
            animationDirection === 1
              ? "Reverse mode phase animation"
              : "Set mode phase animation forward"
          }
          aria-pressed={animationDirection === -1}
          disabled={disabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            onAnimationChange?.({
              animatePhase: animate,
              animationRateHz,
              direction: animationDirection === 1 ? -1 : 1,
              loop: animationLoop,
            })
          }
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
          onClick={() =>
            onAnimationChange?.({
              animatePhase: animate,
              animationRateHz,
              direction: animationDirection,
              loop: !animationLoop,
            })
          }
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

function modeVisualizationIndexLabel(target: ModeVisualizationSelectionRef): string {
  if (target.source === "frequency-response" && target.frequencyIndex !== undefined) {
    return `frequency ${target.frequencyIndex}`;
  }
  if (target.sampleIndex !== undefined && target.modeIndex !== undefined) {
    return `sample ${target.sampleIndex}, mode ${target.modeIndex}`;
  }
  return "field";
}

export function executeModeVisualizationActivation({
  kernel,
  label,
  phaseRad,
  sourceDetail,
  target,
  view,
}: {
  kernel: KernelApi;
  label: string;
  sourceDetail: string;
  target: Pick<ModeVisualizationSelectionRef, "fieldId" | "source">;
  phaseRad?: number;
  view: string;
}) {
  return kernel.commands.execute(
    modeVisualizationCommandId(target),
    createCommandContext("inspector", kernel, { sourceDetail }),
    {
      fieldId: target.fieldId,
      label,
      phaseRad: phaseRad ?? 0,
      source: target.source,
      view,
    },
  );
}

function executeModeVisualizationPhase({
  kernel,
  sourceDetail,
  target,
  phaseRad,
}: {
  kernel: KernelApi;
  sourceDetail: string;
  target: Pick<ModeVisualizationSelectionRef, "source">;
  phaseRad: number;
}) {
  return kernel.commands.execute(
    modeVisualizationPhaseCommandId(target),
    createCommandContext("inspector", kernel, { sourceDetail }),
    { phaseRad },
  );
}

export function ModeVisualizationViewControls({ selection }: InspectorPanelProps) {
  const visualizationViewContext = useVisualizationViewContext();
  const target = modeVisualizationRef(selection);
  const kernel = useKernel();
  const eigenFieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    target?.source === "eigen-mode" ? target.sampleIndex ?? null : null,
    target?.source === "eigen-mode" ? target.modeIndex ?? null : null,
    { enabled: visualizationViewContext !== "planar" },
  );
  const responseFieldMeta = useFrequencyDomainResponseFieldMetaResource(
    target?.source === "frequency-response" ? target.frequencyIndex ?? null : null,
    { enabled: visualizationViewContext !== "planar" },
  );
  const fieldMeta =
    target?.source === "eigen-mode" ? eigenFieldMeta : responseFieldMeta;
  const modeViewOptions = useMemo(
    () =>
      fieldMeta.status === "ready"
        ? analysisFieldViewOptions(
            fieldMeta.data?.available_views,
            fieldMeta.data?.default_view,
          )
        : [],
    [
      fieldMeta.data?.available_views,
      fieldMeta.data?.default_view,
      fieldMeta.status,
    ],
  );
  const modeFieldReady = fieldMeta.status === "ready" &&
    fieldMeta.data != null &&
    canPlotSelectedFieldIn3D(fieldMeta.data);
  const modeFieldStatus = fieldMeta.status === "ready"
    ? selectedField3DPlotStatus(fieldMeta.data)
    : fieldMeta.status === "loading"
      ? "Loading mode field metadata"
      : fieldMeta.status === "error"
        ? "Mode field metadata could not be loaded"
        : "Mode field metadata is not available";
  const defaultPhaseRad =
    fieldMeta.status === "ready"
      ? finiteNumber(fieldMeta.data?.default_phase_rad) ?? 0
      : 0;
  const activeOverlay = useAnalysisFieldOverlay(kernel.analysisFieldOverlay);
  const sourceDetail = useMemo(
    () =>
      target
        ? `Model object mode visualization ${target.objectId} ${modeVisualizationIndexLabel(target)}`
        : "Model object mode visualization",
    [target],
  );
  const settings = useFrequencyDomainModeDisplaySettings({
    activation: target
      ? {
          commandId: modeVisualizationCommandId(target),
          fieldId: target.fieldId,
          label: selection.label ?? modeVisualizationIndexLabel(target),
          source: target.source,
          defaultPhaseRad,
        }
      : undefined,
    sourceDetail,
  });
  const preferredView = normalizeAnalysisFieldView(
    target?.view ?? settings.activeAnalysisFieldOverlay?.query.view,
  );
  const requestedView = modeViewOptions.some((option) => option === preferredView)
    ? preferredView
    : modeViewOptions[0] ?? DEFAULT_ANALYSIS_FIELD_VIEW;
  const activationKey = target
    ? `${target.objectId}:${target.source}:${target.fieldId}:${requestedView}`
    : null;
  const lastActivationKey = useRef<string | null>(null);
  const activeTargetOverlay =
    target &&
    activeOverlay?.fieldId === target.fieldId &&
    activeOverlay.source === target.source
      ? activeOverlay
      : null;
  const overlayPhaseRad = clampPhaseRad(
    finiteNumber(activeTargetOverlay?.visualizationPhaseRad) ??
      finiteNumber(activeTargetOverlay?.query.phase_rad) ??
      PHASE_MIN_RAD,
  );

  useEffect(() => {
    if (visualizationViewContext === "planar") return;
    if (!modeFieldReady) return;
    if (!target || !activationKey) return;
    const overlay = settings.activeAnalysisFieldOverlay;
    if (
      overlay?.fieldId === target.fieldId &&
      overlay.source === target.source &&
      normalizeAnalysisFieldView(overlay.query.view) === requestedView
    ) {
      return;
    }
    if (lastActivationKey.current === activationKey) return;
    lastActivationKey.current = activationKey;
    void executeModeVisualizationActivation({
      kernel,
      label: selection.label ?? modeVisualizationIndexLabel(target),
      sourceDetail,
      target,
      phaseRad: defaultPhaseRad,
      view: requestedView,
    });
  }, [
    activationKey,
    defaultPhaseRad,
    kernel,
    modeFieldReady,
    target,
    requestedView,
    selection.label,
    settings.activeAnalysisFieldOverlay,
    sourceDetail,
    visualizationViewContext,
  ]);

  // The surrounding VisualizationTargetInspectorPanel owns View, Display,
  // surface coloring and vectors (spec 32 §12); only mode-specific sections live here.
  if (!target || visualizationViewContext === "planar") return null;

  const viewValue = modeViewOptions.includes(settings.view) ? settings.view : requestedView;
  const viewSummary = MODE_VIEW_LABELS[viewValue] ?? viewValue;
  const animation = activeTargetOverlay?.animation;

  return (
    <>
      <InspectorGroup
        icon={<Waves aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary={viewSummary}
        title="Complex representation"
        variant="nav"
      >
        <InspectorPropertyRow label="Part">
          <SegmentedControl
            aria-label="Mode complex representation"
            disabled={!modeFieldReady}
            options={modeViewOptions.map((option) => ({
              label: MODE_VIEW_LABELS[option] ?? option,
              value: option,
            }))}
            value={viewValue}
            onValueChange={settings.setView}
          />
        </InspectorPropertyRow>
        {!modeFieldReady ? (
          <FeedbackBanner kind="warning" message={modeFieldStatus} />
        ) : null}
      </InspectorGroup>
      <InspectorGroup
        icon={<Play aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary={animation?.animatePhase
          ? `${animation.animationRateHz ?? 1} cycle/s`
          : `φ ${overlayPhaseRad.toFixed(2)} rad`}
        title="Phase & animation"
        variant="nav"
      >
        <ModeVisualizationPhaseControl
          key={`${target.fieldId}:${target.source}`}
          animate={activeTargetOverlay?.animation?.animatePhase ?? false}
          animationDirection={activeTargetOverlay?.animation?.direction ?? 1}
          animationLoop={activeTargetOverlay?.animation?.loop ?? true}
          animationRateHz={activeTargetOverlay?.animation?.animationRateHz ?? 1}
          disabled={!activeTargetOverlay || !modeFieldReady}
          onAnimationChange={(animation) => {
            kernel.analysisFieldOverlay.update({ animation });
          }}
          onSetPhase={(draft) => {
            const phaseRad = finiteNumber(draft);
            if (!activeTargetOverlay || phaseRad === null) return;
            void executeModeVisualizationPhase({
              kernel,
              phaseRad: clampPhaseRad(phaseRad),
              sourceDetail,
              target,
            });
          }}
          phaseRad={String(overlayPhaseRad)}
        />
        <p className="text-fm-xs text-fm-muted">
          Playback rate is visual only; the physical frequency of the mode does not change.
        </p>
      </InspectorGroup>
    </>
  );
}

const MODE_VIEW_LABELS: Readonly<Record<string, string>> = {
  abs: "|m̃|",
  imag: "Im",
  phase: "arg",
  phase_rotated_real: "Rotated",
  real: "Re",
};

export function ModeVisualizationInspectorPanel(props: InspectorPanelProps) {
  return <ModeVisualizationViewControls {...props} />;
}
