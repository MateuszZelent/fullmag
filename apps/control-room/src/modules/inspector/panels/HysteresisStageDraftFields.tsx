"use client";

import React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  hysteresisFieldUnitScaleToTesla,
  type StudyStageDraft,
} from "./StudyStageAuthoringModel";

export interface StableDraftRow {
  readonly _rowId: string;
}

let fallbackRowCounter = 0;
const initialSlotRowIdCache = new Map<string, string>();

function generateStableRowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackRowCounter += 1;
  return `hyst-row-${fallbackRowCounter}`;
}

function ensureRowId(existingId: unknown, slotKey?: string): string {
  if (typeof existingId === "string" && existingId.length > 0) {
    return existingId;
  }
  if (slotKey) {
    const cached = initialSlotRowIdCache.get(slotKey);
    if (cached) return cached;
    const created = generateStableRowId();
    initialSlotRowIdCache.set(slotKey, created);
    return created;
  }
  return generateStableRowId();
}

export type HysteresisSettleStepDraft = StableDraftRow & {
  [key: string]: unknown;
  step_id?: string;
  kind?: string;
  method?: string;
  alpha?: number | string;
  damping?: number | string;
  torque_tolerance?: number | string;
  energy_tolerance?: number | string;
  max_steps?: number | string;
  timestep_s?: number | string;
  timestep_min_s?: number | string;
  max_pseudotime_s?: number | string;
  max_physical_time_s?: number | string;
  retry_timestep_scale?: number | string;
  retry_max_attempts?: number | string;
  applies_to?: unknown;
  stop_criteria?: unknown;
  on_non_convergence?: string;
};

export type HysteresisFieldSegmentDraft = StableDraftRow & {
  segmentId: string;
  label: string;
  startField: string;
  stopField: string;
  step: string;
  unit: string;
  endpointPolicy: string;
  reason: string;
};

export type HysteresisDenseWindowDraft = StableDraftRow & {
  centerField: string;
  halfWidth: string;
  step: string;
  priority: string;
  reason: string;
};

export type HysteresisMinorLoopDraft = StableDraftRow & {
  reversalField: string;
  returnField: string;
  parentBranch: string;
  closurePolicy: string;
};

export type HysteresisSettleBranchDraft = StableDraftRow & {
  branchId: string;
  when: string;
  run: string;
};

export const DEFAULT_RELAX_SETTLE_STEP: Omit<HysteresisSettleStepDraft, "_rowId"> = {
  kind: "relax",
  method: "llg_overdamped",
  alpha: 1,
  torque_tolerance: "100",
  max_steps: 10000,
  on_non_convergence: "continue_with_warning",
};

export const DEFAULT_MINIMIZE_SETTLE_STEP: Omit<HysteresisSettleStepDraft, "_rowId"> = {
  kind: "minimize",
  method: "projected_gradient_bb",
  torque_tolerance: "100",
  energy_tolerance: "1e-20",
  max_steps: 200,
  on_non_convergence: "continue_with_warning",
};

export const DEFAULT_DYNAMICS_SETTLE_STEP: Omit<HysteresisSettleStepDraft, "_rowId"> = {
  damping: 1,
  kind: "dynamics_settle",
  max_steps: 200,
  method: "heun_dynamics_settle",
  on_non_convergence: "continue_with_warning",
  timestep_s: "1e-12",
};

const FIELD_UNIT_OPTIONS = [
  { value: "mT", label: "mT" },
  { value: "T", label: "T" },
  { value: "Oe", label: "Oe" },
  { value: "kA/m", label: "kA/m" },
] as const;

function convertFieldStringBetweenUnits(
  raw: string,
  fromUnit: string,
  toUnit: string,
): string {
  const num = Number(raw.trim());
  if (!Number.isFinite(num)) return raw;
  const tesla = num * hysteresisFieldUnitScaleToTesla(fromUnit);
  const targetScale = hysteresisFieldUnitScaleToTesla(toUnit);
  const converted = tesla / targetScale;
  return Number(converted.toPrecision(7)).toString();
}

function LabeledInputRow({
  ariaLabel,
  label,
  onChange,
  unit,
  value,
}: {
  ariaLabel?: string;
  label: string;
  onChange: (next: string) => void;
  unit?: string;
  value: string;
}) {
  return (
    <div className="fm-inspector-row" data-layout="inline">
      <span className="fm-inspector-row__label">{label}</span>
      <div className="fm-inspector-row__control flex items-center gap-1.5">
        <Input
          aria-label={ariaLabel ?? label}
          className="h-fm-control-sm"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit ? <span className="text-xs text-fm-muted shrink-0">{unit}</span> : null}
      </div>
    </div>
  );
}

function LabeledSelectRow({
  ariaLabel,
  label,
  onChange,
  options,
  value,
}: {
  ariaLabel?: string;
  label: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <div className="fm-inspector-row" data-layout="inline">
      <span className="fm-inspector-row__label">{label}</span>
      <div className="fm-inspector-row__control">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger aria-label={ariaLabel ?? label} density="compact">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function HysteresisStageDraftFields({
  algorithmsAvailable,
  draft,
  onUpdate,
}: {
  algorithmsAvailable?: readonly string[];
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const storageRecord = parseStoragePolicyDraft(draft.storagePolicy);
  const updateStorage = (patch: Record<string, unknown>) => {
    const next = { ...storageRecord, ...patch };
    onUpdate({ storagePolicy: JSON.stringify(next) });
  };

  return (
    <div className="grid gap-3">
      <LabeledSelectRow
        label="Protocol"
        options={[
          { value: "major_loop", label: "Major loop (+H -> -H -> +H)" },
          { value: "major_with_minor_loops", label: "Major with minor loops" },
          { value: "virgin_curve", label: "Virgin curve (0 -> +H)" },
          { value: "virgin_then_major_loop", label: "Virgin then major loop" },
        ]}
        value={draft.protocolKind || "major_loop"}
        onChange={(protocolKind) => onUpdate({ protocolKind })}
      />
      <LabeledSelectRow
        label="Initial state"
        options={[
          { value: "as_authored", label: "Preceding stage / authored m0" },
          { value: "zero_field_relaxed", label: "Relax at B = 0 first" },
          { value: "positive_saturation", label: "Positive saturation (+H)" },
          { value: "negative_saturation", label: "Negative saturation (-H)" },
          { value: "checkpoint", label: "Checkpoint" },
        ]}
        value={draft.initialStatePolicy || "positive_saturation"}
        onChange={(initialStatePolicy) => onUpdate({ initialStatePolicy })}
      />
      {draft.initialStatePolicy === "checkpoint" ? (
        <LabeledInputRow
          label="Initial state ref"
          value={draft.initialStateRef}
          onChange={(initialStateRef) => onUpdate({ initialStateRef })}
        />
      ) : null}

      <LabeledSelectRow
        label="Orientation mode"
        options={[
          { value: "preset", label: "Axis preset" },
          { value: "sample", label: "Angles (theta, phi)" },
          { value: "global", label: "Global vector 3D" },
        ]}
        value={draft.orientationMode || "preset"}
        onChange={(orientationMode) => onUpdate({ orientationMode })}
      />
      {draft.orientationMode === "sample" ? (
        <>
          <LabeledInputRow
            label="Theta"
            unit="deg"
            value={draft.thetaDeg}
            onChange={(thetaDeg) => onUpdate({ thetaDeg })}
          />
          <LabeledInputRow
            label="Phi"
            unit="deg"
            value={draft.phiDeg}
            onChange={(phiDeg) => onUpdate({ phiDeg })}
          />
        </>
      ) : draft.orientationMode === "global" ? (
        <LabeledInputRow
          label="Field vector"
          value={draft.customDirection}
          onChange={(customDirection) => onUpdate({ customDirection })}
        />
      ) : (
        <LabeledSelectRow
          label="Field preset"
          options={[
            { value: "oop_positive", label: "OOP +z" },
            { value: "oop_negative", label: "OOP -z" },
            { value: "in_plane_x", label: "In-plane +x" },
            { value: "in_plane_y", label: "In-plane +y" },
          ]}
          value={draft.customDirection || "oop_positive"}
          onChange={(customDirection) => onUpdate({ customDirection })}
        />
      )}

      <LabeledSelectRow
        label="Measurement axis"
        options={[
          { value: "field_axis", label: "Along applied field" },
          { value: "sample_normal", label: "Sample normal (+z)" },
          { value: "easy_axis", label: "Primary easy axis" },
          { value: "custom", label: "Custom projection vector" },
        ]}
        value={draft.measurementAxis || "field_axis"}
        onChange={(measurementAxis) => onUpdate({ measurementAxis })}
      />
      {draft.measurementAxis === "custom" ? (
        <LabeledInputRow
          label="Measurement vector"
          value={draft.measurementAxisCustomVector}
          onChange={(measurementAxisCustomVector) =>
            onUpdate({ measurementAxisCustomVector })
          }
        />
      ) : null}

      <LabeledSelectRow
        label="Schedule mode"
        options={[
          { value: "simple", label: "Uniform range" },
          { value: "piecewise", label: "Field segments" },
        ]}
        value={draft.fieldScheduleMode || "simple"}
        onChange={(fieldScheduleMode) => onUpdate({ fieldScheduleMode })}
      />
      <LabeledInputRow
        label="Minimum field"
        unit="mT"
        value={draft.fieldMinMt}
        onChange={(fieldMinMt) => onUpdate({ fieldMinMt })}
      />
      <LabeledInputRow
        label="Maximum field"
        unit="mT"
        value={draft.fieldMaxMt}
        onChange={(fieldMaxMt) => onUpdate({ fieldMaxMt })}
      />
      <LabeledInputRow
        label="Field step"
        unit="mT"
        value={draft.fieldStepMt}
        onChange={(fieldStepMt) => onUpdate({ fieldStepMt })}
      />

      {draft.fieldScheduleMode === "piecewise" ? (
        <HysteresisFieldSegmentsEditor draft={draft} onUpdate={onUpdate} />
      ) : null}

      <HysteresisDenseWindowsEditor draft={draft} onUpdate={onUpdate} />

      <LabeledSelectRow
        label="Saturation mode"
        options={[
          { value: "none", label: "Fixed field bounds" },
          { value: "auto", label: "Stop branch early at saturation" },
        ]}
        value={draft.saturationMode || "none"}
        onChange={(saturationMode) => onUpdate({ saturationMode })}
      />
      {draft.saturationMode === "auto" ? (
        <>
          <LabeledInputRow
            label="Max probe field"
            unit="mT"
            value={draft.maxProbeField}
            onChange={(maxProbeField) => onUpdate({ maxProbeField })}
          />
          <LabeledInputRow
            label="Saturation thresholds"
            value={draft.saturationThresholds}
            onChange={(saturationThresholds) =>
              onUpdate({ saturationThresholds })
            }
          />
        </>
      ) : null}

      <LabeledSelectRow
        label="Settle pipeline"
        options={[
          { value: "sequence", label: "Sequential chain" },
          { value: "tree", label: "Conditional fallback tree" },
        ]}
        value={draft.settlePipelineMode || "sequence"}
        onChange={(settlePipelineMode) => onUpdate({ settlePipelineMode })}
      />
      <HysteresisSettleAlgorithmsEditor
        algorithmsAvailable={algorithmsAvailable}
        draft={draft}
        onUpdate={onUpdate}
      />
      {draft.settlePipelineMode === "tree" ? (
        <HysteresisSettleBranchesEditor draft={draft} onUpdate={onUpdate} />
      ) : null}

      {draft.protocolKind === "major_with_minor_loops" ? (
        <HysteresisMinorLoopsEditor draft={draft} onUpdate={onUpdate} />
      ) : (
        <div className="fm-inspector-row" data-layout="inline">
          <span className="fm-inspector-row__label">Minor loops</span>
          <span className="text-xs text-fm-secondary">
            Enable Major with minor loops protocol to configure reversals
          </span>
        </div>
      )}

      <div className="fm-inspector-form-section">
        <div className="fm-inspector-form-section__header">
          <strong>Storage policy</strong>
        </div>
        <LabeledSelectRow
          label="Snapshot storage mode"
          options={[
            { value: "none", label: "None (scalar table only)" },
            { value: "key_events", label: "Key events (Hc & Mr)" },
            { value: "selected", label: "Selected cadence" },
            { value: "every_n", label: "Every N points" },
            { value: "every_step", label: "Every field point" },
          ]}
          value={String(storageRecord.magnetization ?? "key_events")}
          onChange={(magnetization) =>
            updateStorage({
              magnetization,
              ...(magnetization === "every_n" || magnetization === "selected"
                ? { every_n: Number(storageRecord.every_n ?? 5) || 5 }
                : {}),
            })
          }
        />
        {storageRecord.magnetization === "every_n" ||
        storageRecord.magnetization === "selected" ? (
          <LabeledInputRow
            label="Snapshot cadence N"
            value={String(storageRecord.every_n ?? 5)}
            onChange={(raw) => {
              const parsed = Number(raw.trim());
              updateStorage({
                every_n: Number.isFinite(parsed) ? parsed : raw,
              });
            }}
          />
        ) : null}
        <div className="fm-inspector-row" data-layout="inline">
          <span className="fm-inspector-row__label">
            Storage estimate acknowledged
          </span>
          <div className="fm-inspector-row__control">
            <Checkbox
              aria-label="Storage estimate acknowledged"
              checked={Boolean(draft.storageEstimateAcknowledged)}
              onChange={(event) =>
                onUpdate({ storageEstimateAcknowledged: event.target.checked })
              }
            />
          </div>
        </div>
      </div>

      <LabeledInputRow
        label="Stage torque tolerance"
        unit="A/m"
        value={draft.torqueTolerance}
        onChange={(torqueTolerance) => onUpdate({ torqueTolerance })}
      />
    </div>
  );
}

export function HysteresisFieldSegmentsEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const segments = parseHysteresisFieldSegments(draft.fieldSegments, draft.stageId);
  const commitSegments = (nextSegments: HysteresisFieldSegmentDraft[]) => {
    onUpdate({ fieldSegments: JSON.stringify(nextSegments) });
  };
  const updateSegment = (
    index: number,
    patch: Partial<HysteresisFieldSegmentDraft>,
  ) => {
    commitSegments(
      segments.map((segment, segmentIndex) =>
        segmentIndex === index ? { ...segment, ...patch } : segment,
      ),
    );
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Piecewise field segments</strong>
      </div>
      {segments.map((segment, index) => (
        <div className="fm-inspector-form-section" key={segment._rowId}>
          <div className="fm-inspector-form-section__header">
            <strong>Segment {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label={`Remove segment ${index + 1}`}
                disabled={segments.length <= 1}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitSegments(
                    segments.filter((_, segmentIndex) => segmentIndex !== index),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <LabeledInputRow
            ariaLabel={`Segment ${index + 1} ID`}
            label="Segment ID"
            value={segment.segmentId}
            onChange={(segmentId) => updateSegment(index, { segmentId })}
          />
          <LabeledInputRow
            ariaLabel={`Segment ${index + 1} label`}
            label="Label"
            value={segment.label}
            onChange={(label) => updateSegment(index, { label })}
          />
          <LabeledSelectRow
            ariaLabel={`Segment ${index + 1} unit`}
            label="Field unit"
            options={FIELD_UNIT_OPTIONS}
            value={segment.unit || "mT"}
            onChange={(nextUnit) =>
              updateSegment(index, {
                startField: convertFieldStringBetweenUnits(
                  segment.startField,
                  segment.unit || "mT",
                  nextUnit,
                ),
                stopField: convertFieldStringBetweenUnits(
                  segment.stopField,
                  segment.unit || "mT",
                  nextUnit,
                ),
                step: convertFieldStringBetweenUnits(
                  segment.step,
                  segment.unit || "mT",
                  nextUnit,
                ),
                unit: nextUnit,
              })
            }
          />
          <LabeledInputRow
            ariaLabel={`Segment ${index + 1} start field`}
            label="Start field"
            unit={segment.unit || "mT"}
            value={segment.startField}
            onChange={(startField) => updateSegment(index, { startField })}
          />
          <LabeledInputRow
            ariaLabel={`Segment ${index + 1} stop field`}
            label="Stop field"
            unit={segment.unit || "mT"}
            value={segment.stopField}
            onChange={(stopField) => updateSegment(index, { stopField })}
          />
          <LabeledInputRow
            ariaLabel={`Segment ${index + 1} step`}
            label="Step"
            unit={segment.unit || "mT"}
            value={segment.step}
            onChange={(step) => updateSegment(index, { step })}
          />
          <LabeledSelectRow
            ariaLabel={`Segment ${index + 1} endpoint policy`}
            label="Endpoint policy"
            options={[
              { value: "include_stop", label: "Include stop" },
              { value: "skip_start", label: "Skip start" },
              { value: "include_both", label: "Include both" },
            ]}
            value={segment.endpointPolicy}
            onChange={(endpointPolicy) =>
              updateSegment(index, { endpointPolicy })
            }
          />
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitSegments([
              ...segments,
              defaultHysteresisFieldSegment(segments.length),
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add segment</span>
        </Button>
      </div>
    </div>
  );
}

export function HysteresisDenseWindowsEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const windows = parseHysteresisDenseWindows(draft.denseWindows, draft.stageId);
  const commitWindows = (nextWindows: HysteresisDenseWindowDraft[]) => {
    onUpdate({ denseWindows: JSON.stringify(nextWindows) });
  };
  const updateWindow = (
    index: number,
    patch: Partial<HysteresisDenseWindowDraft>,
  ) => {
    commitWindows(
      windows.map((window, windowIndex) =>
        windowIndex === index ? { ...window, ...patch } : window,
      ),
    );
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Dense refinement windows · Dense windows</strong>
      </div>
      {windows.map((window, index) => (
        <div className="fm-inspector-form-section" key={window._rowId}>
          <div className="fm-inspector-form-section__header">
            <strong>Window {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label={`Remove dense window ${index + 1}`}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitWindows(
                    windows.filter((_, windowIndex) => windowIndex !== index),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <LabeledInputRow
            ariaLabel={`Window ${index + 1} center field`}
            label="Center field"
            unit="mT"
            value={window.centerField}
            onChange={(centerField) => updateWindow(index, { centerField })}
          />
          <LabeledInputRow
            ariaLabel={`Window ${index + 1} half width`}
            label="Half width"
            unit="mT"
            value={window.halfWidth}
            onChange={(halfWidth) => updateWindow(index, { halfWidth })}
          />
          <LabeledInputRow
            ariaLabel={`Window ${index + 1} step`}
            label="Fine step"
            unit="mT"
            value={window.step}
            onChange={(step) => updateWindow(index, { step })}
          />
          <LabeledInputRow
            ariaLabel={`Window ${index + 1} priority`}
            label="Priority"
            value={window.priority}
            onChange={(priority) => updateWindow(index, { priority })}
          />
          <LabeledInputRow
            ariaLabel={`Window ${index + 1} reason`}
            label="Reason"
            value={window.reason}
            onChange={(reason) => updateWindow(index, { reason })}
          />
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitWindows([
              ...windows,
              defaultHysteresisDenseWindow(windows.length, draft),
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add window</span>
        </Button>
      </div>
    </div>
  );
}

export function HysteresisMinorLoopsEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const loops = parseHysteresisMinorLoops(draft.minorLoops, draft.stageId);
  const commitLoops = (nextLoops: HysteresisMinorLoopDraft[]) => {
    onUpdate({ minorLoops: JSON.stringify(nextLoops) });
  };
  const updateLoop = (
    index: number,
    patch: Partial<HysteresisMinorLoopDraft>,
  ) => {
    commitLoops(
      loops.map((loop, loopIndex) =>
        loopIndex === index ? { ...loop, ...patch } : loop,
      ),
    );
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Minor loops</strong>
      </div>
      {loops.map((loop, index) => (
        <div className="fm-inspector-form-section" key={loop._rowId}>
          <div className="fm-inspector-form-section__header">
            <strong>Loop {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label={`Remove minor loop ${index + 1}`}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitLoops(loops.filter((_, loopIndex) => loopIndex !== index))
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <LabeledInputRow
            ariaLabel={`Minor loop ${index + 1} reversal field`}
            label="Reversal field"
            unit="mT"
            value={loop.reversalField}
            onChange={(reversalField) => updateLoop(index, { reversalField })}
          />
          <LabeledInputRow
            ariaLabel={`Minor loop ${index + 1} return field`}
            label="Return field"
            unit="mT"
            value={loop.returnField}
            onChange={(returnField) => updateLoop(index, { returnField })}
          />
          <LabeledSelectRow
            ariaLabel={`Minor loop ${index + 1} parent branch`}
            label="Parent branch"
            options={[
              { value: "descending", label: "Descending" },
              { value: "ascending", label: "Ascending" },
              { value: "major", label: "Major" },
            ]}
            value={loop.parentBranch}
            onChange={(parentBranch) => updateLoop(index, { parentBranch })}
          />
          <LabeledSelectRow
            ariaLabel={`Minor loop ${index + 1} closure policy`}
            label="Closure policy"
            options={[
              { value: "branch_only", label: "Branch only" },
              { value: "resume_parent", label: "Resume parent" },
              { value: "replace_parent", label: "Replace parent" },
            ]}
            value={loop.closurePolicy}
            onChange={(closurePolicy) => updateLoop(index, { closurePolicy })}
          />
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitLoops([
              ...loops,
              defaultHysteresisMinorLoop(loops.length, draft),
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add minor loop</span>
        </Button>
      </div>
    </div>
  );
}

export function HysteresisSettleAlgorithmsEditor({
  algorithmsAvailable,
  draft,
  onUpdate,
}: {
  algorithmsAvailable?: readonly string[];
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const steps = parseHysteresisSettleSteps(draft.settleSteps, draft.stageId);
  const commitSteps = (nextSteps: HysteresisSettleStepDraft[]) => {
    onUpdate({
      settleSteps: JSON.stringify(
        nextSteps.map((step) => {
          const {
            _rowId,
            alpha,
            applies_to,
            damping,
            energy_tolerance,
            kind,
            max_physical_time_s,
            max_pseudotime_s,
            max_steps,
            method,
            on_non_convergence,
            retry_max_attempts,
            retry_timestep_scale,
            step_id,
            stop_criteria,
            timestep_min_s,
            timestep_s,
            torque_tolerance,
            ...preservedFields
          } = step;
          const serializedStep: Record<string, unknown> = {
            ...preservedFields,
            _rowId,
            step_id,
            kind,
            method,
            on_non_convergence,
          };
          copyDefinedSettleStepValue({ alpha } as HysteresisSettleStepDraft, serializedStep, "alpha", Number);
          copyDefinedSettleStepValue({ damping } as HysteresisSettleStepDraft, serializedStep, "damping", Number);
          copyDefinedSettleStepValue(
            { torque_tolerance } as HysteresisSettleStepDraft,
            serializedStep,
            "torque_tolerance",
            Number,
          );
          copyDefinedSettleStepValue(
            { energy_tolerance } as HysteresisSettleStepDraft,
            serializedStep,
            "energy_tolerance",
            Number,
          );
          copyDefinedSettleStepValue({ max_steps } as HysteresisSettleStepDraft, serializedStep, "max_steps", Number);
          copyDefinedSettleStepValue(
            { timestep_s } as HysteresisSettleStepDraft,
            serializedStep,
            "timestep_s",
            Number,
          );
          copyDefinedSettleStepValue(
            { timestep_min_s } as HysteresisSettleStepDraft,
            serializedStep,
            "timestep_min_s",
            Number,
          );
          copyDefinedSettleStepValue(
            { max_pseudotime_s } as HysteresisSettleStepDraft,
            serializedStep,
            "max_pseudotime_s",
            Number,
          );
          copyDefinedSettleStepValue(
            { max_physical_time_s } as HysteresisSettleStepDraft,
            serializedStep,
            "max_physical_time_s",
            Number,
          );
          copyDefinedSettleStepValue(
            { retry_timestep_scale } as HysteresisSettleStepDraft,
            serializedStep,
            "retry_timestep_scale",
            Number,
          );
          copyDefinedSettleStepValue(
            { retry_max_attempts } as HysteresisSettleStepDraft,
            serializedStep,
            "retry_max_attempts",
            Number,
          );
          if (applies_to != null) {
            serializedStep.applies_to = parseJsonObjectOrString(String(applies_to));
          }
          if (stop_criteria != null) {
            serializedStep.stop_criteria = parseJsonObjectOrString(
              String(stop_criteria),
            );
          }
          return serializedStep;
        }),
      ),
    });
  };
  const updateStep = (
    index: number,
    patch: Partial<HysteresisSettleStepDraft>,
  ) => {
    commitSteps(
      steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step,
      ),
    );
  };
  const moveStep = (index: number, direction: "up" | "down") => {
    const nextSteps = [...steps];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    const temp = nextSteps[index]!;
    nextSteps[index] = nextSteps[targetIndex]!;
    nextSteps[targetIndex] = temp;
    commitSteps(nextSteps);
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Settle algorithms · Settle steps</strong>
      </div>
      {steps.map((step, index) => {
        const stepKind = step.kind || "relax";
        return (
          <div className="fm-inspector-form-section" key={step._rowId}>
            <div className="fm-inspector-form-section__header">
              <strong>Algorithm {index + 1}</strong>
              <div className="fm-inspector-toolbar">
                <Button
                  aria-label="Move algorithm up"
                  disabled={index === 0}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => moveStep(index, "up")}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </Button>
                <Button
                  aria-label="Move algorithm down"
                  disabled={index === steps.length - 1}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => moveStep(index, "down")}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </Button>
                <Button
                  aria-label={`Remove step ${index + 1}`}
                  disabled={steps.length <= 1}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    commitSteps(steps.filter((_, stepIndex) => stepIndex !== index))
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
            </div>
            <LabeledInputRow
              ariaLabel={`Step ${index + 1} ID`}
              label="Step ID"
              value={String(step.step_id ?? "")}
              onChange={(step_id) => updateStep(index, { step_id })}
            />
            <LabeledSelectRow
              ariaLabel={`Step ${index + 1} kind`}
              label="Kind"
              options={[
                { value: "relax", label: "Relaxation" },
                { value: "minimize", label: "Energy minimization" },
                { value: "dynamics_settle", label: "Dynamics settle" },
              ]}
              value={stepKind}
              onChange={(nextKind) => {
                const defaults =
                  nextKind === "relax"
                    ? DEFAULT_RELAX_SETTLE_STEP
                    : nextKind === "minimize"
                      ? DEFAULT_MINIMIZE_SETTLE_STEP
                      : DEFAULT_DYNAMICS_SETTLE_STEP;
                updateStep(index, {
                  ...defaults,
                  _rowId: step._rowId,
                  kind: nextKind,
                  step_id: step.step_id,
                });
              }}
            />
            <LabeledSelectRow
              ariaLabel={`Step ${index + 1} method`}
              label="Method"
              options={hysteresisSettleMethodOptions(stepKind).map((option) => {
                const unavailable =
                  Array.isArray(algorithmsAvailable) &&
                  algorithmsAvailable.length > 0 &&
                  !algorithmsAvailable.includes(option);
                const baseLabel = hysteresisSettleMethodLabel(option);
                return {
                  value: option,
                  label: unavailable
                    ? `${baseLabel} (unavailable on active lane)`
                    : baseLabel,
                };
              })}
              value={String(step.method ?? "")}
              onChange={(method) => updateStep(index, { method })}
            />
            {stepKind === "relax" ? (
              <LabeledInputRow
                ariaLabel={`Step ${index + 1} alpha`}
                label="Alpha"
                value={String(step.alpha ?? "")}
                onChange={(alpha) => updateStep(index, { alpha })}
              />
            ) : null}
            {stepKind === "relax" || stepKind === "minimize" ? (
              <LabeledInputRow
                ariaLabel={`Step ${index + 1} torque tolerance`}
                label="Max torque tolerance"
                unit="A/m"
                value={String(step.torque_tolerance ?? "")}
                onChange={(torque_tolerance) =>
                  updateStep(index, { torque_tolerance })
                }
              />
            ) : null}
            {stepKind === "minimize" ? (
              <LabeledInputRow
                ariaLabel={`Step ${index + 1} energy tolerance`}
                label="Energy tolerance"
                unit="J"
                value={String(step.energy_tolerance ?? "")}
                onChange={(energy_tolerance) =>
                  updateStep(index, { energy_tolerance })
                }
              />
            ) : null}
            {stepKind === "dynamics_settle" ? (
              <>
                <LabeledInputRow
                  ariaLabel={`Step ${index + 1} damping`}
                  label="Damping"
                  value={String(step.damping ?? "")}
                  onChange={(damping) => updateStep(index, { damping })}
                />
                <LabeledInputRow
                  ariaLabel={`Step ${index + 1} timestep`}
                  label="Timestep"
                  unit="s"
                  value={String(step.timestep_s ?? "")}
                  onChange={(timestep_s) => updateStep(index, { timestep_s })}
                />
                <LabeledInputRow
                  ariaLabel={`Step ${index + 1} retry scale`}
                  label="Retry scale"
                  value={String(step.retry_timestep_scale ?? "")}
                  onChange={(retry_timestep_scale) =>
                    updateStep(index, { retry_timestep_scale })
                  }
                />
                <LabeledInputRow
                  ariaLabel={`Step ${index + 1} retry attempts`}
                  label="Retry attempts"
                  value={String(step.retry_max_attempts ?? "")}
                  onChange={(retry_max_attempts) =>
                    updateStep(index, { retry_max_attempts })
                  }
                />
              </>
            ) : null}
            <LabeledInputRow
              ariaLabel={`Step ${index + 1} max steps`}
              label="Max steps"
              value={String(step.max_steps ?? "")}
              onChange={(max_steps) => updateStep(index, { max_steps })}
            />
            <LabeledSelectRow
              ariaLabel={`Step ${index + 1} non-convergence`}
              label="On non-convergence"
              options={[
                { value: "continue_with_warning", label: "Continue with warning" },
                { value: "stop_stage", label: "Stop stage" },
                { value: "run_next_algorithm", label: "Run next algorithm" },
                { value: "retry_with_smaller_dt", label: "Retry with smaller dt" },
              ]}
              value={String(step.on_non_convergence ?? "continue_with_warning")}
              onChange={(on_non_convergence) =>
                updateStep(index, { on_non_convergence })
              }
            />
            <LabeledInputRow
              ariaLabel={`Step ${index + 1} applies to`}
              label="Applies to (optional)"
              value={
                step.applies_to == null
                  ? ""
                  : typeof step.applies_to === "string"
                    ? step.applies_to
                    : JSON.stringify(step.applies_to)
              }
              onChange={(raw) =>
                updateStep(index, {
                  applies_to: raw.trim() ? raw : undefined,
                })
              }
            />
            <LabeledInputRow
              ariaLabel={`Step ${index + 1} stop criteria`}
              label="Stop criteria JSON (optional)"
              value={
                step.stop_criteria == null
                  ? ""
                  : typeof step.stop_criteria === "string"
                    ? step.stop_criteria
                    : JSON.stringify(step.stop_criteria)
              }
              onChange={(raw) =>
                updateStep(index, {
                  stop_criteria: raw.trim() ? raw : undefined,
                })
              }
            />
          </div>
        );
      })}
      <div className="fm-inspector-toolbar fm-mt-2">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitSteps([
              ...steps,
              {
                ...DEFAULT_RELAX_SETTLE_STEP,
                _rowId: generateStableRowId(),
                step_id: `relax-${steps.length + 1}`,
              },
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add relax</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitSteps([
              ...steps,
              {
                ...DEFAULT_MINIMIZE_SETTLE_STEP,
                _rowId: generateStableRowId(),
                step_id: `minimize-${steps.length + 1}`,
              },
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add minimize</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitSteps([
              ...steps,
              {
                ...DEFAULT_DYNAMICS_SETTLE_STEP,
                _rowId: generateStableRowId(),
                step_id: `dynamics-${steps.length + 1}`,
              },
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add dynamics</span>
        </Button>
      </div>
    </div>
  );
}

export function HysteresisSettleBranchesEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const branches = parseHysteresisSettleBranches(draft.settleBranches, draft.stageId);
  const commitBranches = (nextBranches: HysteresisSettleBranchDraft[]) => {
    onUpdate({
      settleBranches: JSON.stringify(
        nextBranches.map((branch) => ({
          _rowId: branch._rowId,
          branch_id: branch.branchId,
          run: parseJsonObjectOrString(branch.run),
          when: branch.when,
        })),
      ),
    });
  };
  const updateBranch = (
    index: number,
    patch: Partial<HysteresisSettleBranchDraft>,
  ) => {
    commitBranches(
      branches.map((branch, branchIndex) =>
        branchIndex === index ? { ...branch, ...patch } : branch,
      ),
    );
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Settle branches</strong>
      </div>
      {branches.map((branch, index) => (
        <div className="fm-inspector-form-section" key={branch._rowId}>
          <div className="fm-inspector-form-section__header">
            <strong>Branch {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label={`Remove settle branch ${index + 1}`}
                disabled={branches.length <= 1}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitBranches(
                    branches.filter((_, branchIndex) => branchIndex !== index),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <LabeledInputRow
            ariaLabel={`Branch ${index + 1} ID`}
            label="Branch ID"
            value={branch.branchId}
            onChange={(branchId) => updateBranch(index, { branchId })}
          />
          <LabeledSelectRow
            ariaLabel={`Branch ${index + 1} trigger`}
            label="Trigger"
            options={[
              { value: "non_converged", label: "Non-converged fallback" },
              { value: "fallback", label: "Fallback" },
              { value: "run_next_algorithm", label: "Run next algorithm" },
              { value: "always", label: "Always" },
            ]}
            value={branch.when}
            onChange={(when) => updateBranch(index, { when })}
          />
          <LabeledInputRow
            ariaLabel={`Branch ${index + 1} run step JSON`}
            label="Run step JSON"
            value={branch.run}
            onChange={(run) => updateBranch(index, { run })}
          />
        </div>
      ))}
      <div className="fm-inspector-toolbar fm-mt-2">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            commitBranches([
              ...branches,
              defaultHysteresisSettleBranch(branches.length),
            ])
          }
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add branch</span>
        </Button>
      </div>
    </div>
  );
}

export function parseHysteresisSettleSteps(
  value: string | null | undefined,
  scopeId = "default",
): HysteresisSettleStepDraft[] {
  try {
    const raw = value ? JSON.parse(value) : null;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((item, idx) => {
        const record = isRecord(item) ? item : {};
        const step: HysteresisSettleStepDraft = {
          ...record,
          _rowId: ensureRowId(record._rowId, `${scopeId}:settleStep:${idx}`),
          step_id: stringFromUnknown(record.step_id, ""),
          kind: stringFromUnknown(record.kind, "relax"),
          method: stringFromUnknown(record.method, ""),
          on_non_convergence: stringFromUnknown(
            record.on_non_convergence,
            "continue_with_warning",
          ),
        };
        for (const numericKey of [
          "alpha",
          "damping",
          "torque_tolerance",
          "energy_tolerance",
          "max_steps",
          "timestep_s",
          "timestep_min_s",
          "max_pseudotime_s",
          "max_physical_time_s",
          "retry_timestep_scale",
          "retry_max_attempts",
        ]) {
          normalizeHysteresisSettleStepPatch(record, step, numericKey);
        }
        if (record.applies_to != null) step.applies_to = record.applies_to;
        if (record.stop_criteria != null) step.stop_criteria = record.stop_criteria;
        return step;
      });
    }
  } catch {
    // Fallback below
  }
  return [
    {
      ...DEFAULT_RELAX_SETTLE_STEP,
      _rowId: ensureRowId(undefined, `${scopeId}:settleStep:0`),
      step_id: "relax-1",
    },
  ];
}

export function parseHysteresisFieldSegments(
  value: string | null | undefined,
  scopeId = "default",
): HysteresisFieldSegmentDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((segment, idx) =>
      isRecord(segment)
        ? [normalizeHysteresisFieldSegment(segment, idx, scopeId)]
        : [],
    );
  } catch {
    return [];
  }
}

function normalizeHysteresisFieldSegment(
  segment: Record<string, unknown>,
  index: number,
  scopeId: string,
): HysteresisFieldSegmentDraft {
  const unit = stringFromUnknown(segment.unit, "mT");
  return {
    _rowId: ensureRowId(segment._rowId, `${scopeId}:fieldSegment:${index}`),
    endpointPolicy: stringFromUnknown(
      segment.endpointPolicy ?? segment.endpoint_policy,
      "include_stop",
    ),
    label: stringFromUnknown(segment.label, `Segment ${index + 1}`),
    reason: stringFromUnknown(segment.reason, ""),
    segmentId: stringFromUnknown(
      segment.segmentId ?? segment.segment_id,
      `seg-${index + 1}`,
    ),
    startField: stringFromUnknown(
      segment.startField ?? segment.start_field ?? segment.start,
      unit === "T" ? "0.2" : "200",
    ),
    step: stringFromUnknown(segment.step, unit === "T" ? "0.005" : "5"),
    stopField: stringFromUnknown(
      segment.stopField ?? segment.stop_field ?? segment.stop,
      unit === "T" ? "-0.2" : "-200",
    ),
    unit,
  };
}

function defaultHysteresisFieldSegment(index: number): HysteresisFieldSegmentDraft {
  return {
    _rowId: generateStableRowId(),
    endpointPolicy: "include_stop",
    label: `Segment ${index + 1}`,
    reason: "",
    segmentId: `seg-${index + 1}`,
    startField: "200",
    step: "5",
    stopField: "-200",
    unit: "mT",
  };
}

export function parseHysteresisDenseWindows(
  value: string | null | undefined,
  scopeId = "default",
): HysteresisDenseWindowDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [];
    let index = 0;
    return parsed.flatMap((window) => {
      if (!isRecord(window)) return [];
      const normalized = normalizeHysteresisDenseWindow(window, index, scopeId);
      index += 1;
      return [normalized];
    });
  } catch {
    return [];
  }
}

function normalizeHysteresisDenseWindow(
  window: Record<string, unknown>,
  index: number,
  scopeId: string,
): HysteresisDenseWindowDraft {
  return {
    _rowId: ensureRowId(window._rowId, `${scopeId}:denseWindow:${index}`),
    centerField: stringFromUnknown(
      window.centerField ?? window.centerMt ?? window.center_mT ?? window.center,
      "0",
    ),
    halfWidth: stringFromUnknown(
      window.halfWidth ??
        window.halfWidthMt ??
        window.half_width_mT ??
        window.half_width,
      "20",
    ),
    priority: stringFromUnknown(window.priority, String(index + 1)),
    reason: stringFromUnknown(window.reason, ""),
    step: stringFromUnknown(window.step ?? window.stepMt ?? window.step_mT, "1"),
  };
}

function defaultHysteresisDenseWindow(
  index: number,
  draft?: StudyStageDraft,
): HysteresisDenseWindowDraft {
  return {
    _rowId: generateStableRowId(),
    centerField: "0",
    halfWidth: "20",
    priority: String(index + 1),
    reason: index === 0 ? "coercivity" : "",
    step: draft?.fieldStepMt || "1",
  };
}

export function parseHysteresisMinorLoops(
  value: string | null | undefined,
  scopeId = "default",
): HysteresisMinorLoopDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((loop, idx) =>
      isRecord(loop) ? [normalizeHysteresisMinorLoop(loop, idx, scopeId)] : [],
    );
  } catch {
    return [];
  }
}

function normalizeHysteresisMinorLoop(
  loop: Record<string, unknown>,
  index: number,
  scopeId: string,
): HysteresisMinorLoopDraft {
  return {
    _rowId: ensureRowId(loop._rowId, `${scopeId}:minorLoop:${index}`),
    closurePolicy: stringFromUnknown(
      loop.closurePolicy ?? loop.closure_policy ?? loop.continuation_policy,
      "branch_only",
    ),
    parentBranch: stringFromUnknown(
      loop.parentBranch ?? loop.parent_branch,
      "descending",
    ),
    returnField: stringFromUnknown(
      loop.returnField ?? loop.returnMt ?? loop.return_mT,
      "-50",
    ),
    reversalField: stringFromUnknown(
      loop.reversalField ?? loop.reversalMt ?? loop.reversal_mT,
      "50",
    ),
  };
}

function defaultHysteresisMinorLoop(
  index: number,
  draft?: StudyStageDraft,
): HysteresisMinorLoopDraft {
  const fieldStep = Number(draft?.fieldStepMt);
  const offset = Number.isFinite(fieldStep) && fieldStep > 0 ? fieldStep : 25;
  return {
    _rowId: generateStableRowId(),
    closurePolicy: "branch_only",
    parentBranch: "descending",
    returnField: String(-offset * (index + 1)),
    reversalField: String(offset * (index + 1)),
  };
}

export function parseHysteresisSettleBranches(
  value: string | null | undefined,
  scopeId = "default",
): HysteresisSettleBranchDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [];
    let branchIndex = 0;
    return parsed.flatMap((branch) => {
      if (!isRecord(branch)) return [];
      const normalized = normalizeHysteresisSettleBranch(branch, branchIndex, scopeId);
      branchIndex += 1;
      return [normalized];
    });
  } catch {
    return [];
  }
}

function normalizeHysteresisSettleBranch(
  branch: Record<string, unknown>,
  index: number,
  scopeId: string,
): HysteresisSettleBranchDraft {
  return {
    _rowId: ensureRowId(branch._rowId, `${scopeId}:settleBranch:${index}`),
    branchId: stringFromUnknown(
      branch.branchId ?? branch.branch_id,
      index === 0 ? "non_converged_fallback" : `settle_branch_${index + 1}`,
    ),
    run: stringifyJsonDraftValue(branch.run, DEFAULT_RELAX_SETTLE_STEP),
    when: stringFromUnknown(branch.when, "non_converged"),
  };
}

function defaultHysteresisSettleBranch(
  index: number,
): HysteresisSettleBranchDraft {
  return {
    _rowId: generateStableRowId(),
    branchId:
      index === 0 ? "non_converged_fallback" : `settle_branch_${index + 1}`,
    run: JSON.stringify(DEFAULT_RELAX_SETTLE_STEP),
    when: index === 0 ? "non_converged" : "always",
  };
}

function parseStoragePolicyDraft(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return isRecord(parsed) ? parsed : { magnetization: "key_events" };
  } catch {
    return { magnetization: "key_events" };
  }
}

function stringifyJsonDraftValue(value: unknown, fallback: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function parseJsonObjectOrString(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function stringFromUnknown(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function normalizeHysteresisSettleStepPatch(
  item: Record<string, unknown>,
  step: HysteresisSettleStepDraft,
  field: string,
) {
  const value = item[field];
  if (value != null) {
    step[field] = String(value);
  }
}

function copyDefinedSettleStepValue(
  step: HysteresisSettleStepDraft,
  target: Record<string, unknown>,
  field: string,
  parseFunc: (val: string) => number,
) {
  const value = step[field];
  if (value != null) {
    const stringValue = String(value).trim();
    if (stringValue) {
      const parsedValue = parseFunc(stringValue);
      if (!Number.isNaN(parsedValue)) {
        target[field] = parsedValue;
      } else {
        target[field] = stringValue;
      }
    }
  }
}

function hysteresisSettleMethodOptions(kind?: string) {
  if (kind === "minimize") {
    return ["projected_gradient_bb", "nonlinear_cg", "tangent_plane_implicit"];
  }
  if (kind === "dynamics_settle") {
    return ["heun_dynamics_settle"];
  }
  return [
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
  ];
}

const HYSTERESIS_SETTLE_METHOD_LABELS: Record<string, string> = {
  heun_dynamics_settle: "Heun dynamics settle",
  llg_overdamped: "LLG overdamped",
  nonlinear_cg: "Nonlinear conjugate gradient",
  projected_gradient_bb: "Projected gradient BB",
  tangent_plane_implicit: "Tangent-plane implicit",
};

function hysteresisSettleMethodLabel(method: string): string {
  return HYSTERESIS_SETTLE_METHOD_LABELS[method] ?? method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
