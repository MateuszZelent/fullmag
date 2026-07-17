"use client";

import React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { FormField } from "../primitives/FormField";
import { type StudyStageDraft } from "./StudyStageAuthoringModel";

export type HysteresisSettleStepDraft = {
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
  retry_timestep_scale?: number | string;
  retry_max_attempts?: number | string;
  applies_to?: unknown;
  stop_criteria?: unknown;
  on_non_convergence?: string;
};

export type HysteresisFieldSegmentDraft = {
  segmentId: string;
  label: string;
  startField: string;
  stopField: string;
  step: string;
  unit: string;
  endpointPolicy: string;
  reason: string;
};

export type HysteresisDenseWindowDraft = {
  centerField: string;
  halfWidth: string;
  step: string;
  priority: string;
  reason: string;
};

export type HysteresisMinorLoopDraft = {
  reversalField: string;
  returnField: string;
  parentBranch: string;
  closurePolicy: string;
};

export type HysteresisSettleBranchDraft = {
  branchId: string;
  when: string;
  run: string;
};

export const DEFAULT_RELAX_SETTLE_STEP: HysteresisSettleStepDraft = {
  kind: "relax",
  method: "llg_overdamped",
  alpha: 1,
  torque_tolerance: "1e-6",
  max_steps: 10000,
  on_non_convergence: "continue_with_warning",
};

export const DEFAULT_MINIMIZE_SETTLE_STEP: HysteresisSettleStepDraft = {
  kind: "minimize",
  method: "projected_gradient_bb",
  energy_tolerance: "1e-20",
  max_steps: 200,
  on_non_convergence: "continue_with_warning",
};

export const DEFAULT_DYNAMICS_SETTLE_STEP: HysteresisSettleStepDraft = {
  damping: 1,
  kind: "dynamics_settle",
  max_steps: 200,
  method: "heun_dynamics_settle",
  on_non_convergence: "continue_with_warning",
  timestep_s: "1e-12",
};

export function HysteresisStageDraftFields({
  algorithmsAvailable,
  draft,
  onUpdate,
}: {
  algorithmsAvailable?: readonly string[];
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Protocol"
        type="select"
        value={draft.protocolKind}
        onChange={(event) => onUpdate({ protocolKind: event.target.value })}
      >
        <option value="major_loop">Major loop</option>
        <option value="major_with_minor_loops">Major with minor loops</option>
        <option value="virgin_curve">Virgin curve</option>
        <option value="virgin_then_major_loop">Virgin then major loop</option>
      </FormField>
      <FormField
        label="Initial state"
        type="select"
        value={draft.initialStatePolicy}
        onChange={(event) =>
          onUpdate({ initialStatePolicy: event.target.value })
        }
      >
        <option value="as_authored">As authored</option>
        <option value="zero_field_relaxed">Zero-field relaxed</option>
        <option value="positive_saturation">Positive saturation</option>
        <option value="negative_saturation">Negative saturation</option>
        <option value="checkpoint">Checkpoint</option>
      </FormField>
      {draft.initialStatePolicy === "checkpoint" ? (
        <FormField
          label="Initial state ref"
          value={draft.initialStateRef}
          onChange={(event) =>
            onUpdate({ initialStateRef: event.target.value })
          }
        />
      ) : null}
      <FormField
        label="Orientation mode"
        type="select"
        value={draft.orientationMode}
        onChange={(event) => onUpdate({ orientationMode: event.target.value })}
      >
        <option value="preset">Preset</option>
        <option value="sample">Sample angles</option>
        <option value="global">Global vector</option>
      </FormField>
      {draft.orientationMode === "sample" ? (
        <>
          <FormField
            label="Theta"
            unit="deg"
            value={draft.thetaDeg}
            onChange={(event) => onUpdate({ thetaDeg: event.target.value })}
          />
          <FormField
            label="Phi"
            unit="deg"
            value={draft.phiDeg}
            onChange={(event) => onUpdate({ phiDeg: event.target.value })}
          />
        </>
      ) : draft.orientationMode === "global" ? (
        <FormField
          label="Field vector"
          value={draft.customDirection}
          onChange={(event) =>
            onUpdate({ customDirection: event.target.value })
          }
        />
      ) : (
        <FormField
          label="Field preset"
          type="select"
          value={draft.customDirection}
          onChange={(event) =>
            onUpdate({ customDirection: event.target.value })
          }
        >
          <option value="oop_positive">OOP +z</option>
          <option value="oop_negative">OOP -z</option>
          <option value="in_plane_x">In-plane x</option>
          <option value="in_plane_y">In-plane y</option>
        </FormField>
      )}
      <FormField
        label="Measurement axis"
        type="select"
        value={draft.measurementAxis}
        onChange={(event) => onUpdate({ measurementAxis: event.target.value })}
      >
        <option value="field_axis">Field axis</option>
        <option value="sample_normal">Sample normal</option>
        <option value="easy_axis">Easy axis</option>
        <option value="custom">Custom</option>
      </FormField>
      {draft.measurementAxis === "custom" ? (
        <FormField
          label="Measurement vector"
          value={draft.measurementAxisCustomVector}
          onChange={(event) =>
            onUpdate({ measurementAxisCustomVector: event.target.value })
          }
        />
      ) : null}
      <FormField
        label="Schedule mode"
        type="select"
        value={draft.fieldScheduleMode}
        onChange={(event) =>
          onUpdate({ fieldScheduleMode: event.target.value })
        }
      >
        <option value="simple">Simple</option>
        <option value="piecewise">Piecewise</option>
      </FormField>
      <FormField
        label="Minimum field"
        unit="mT"
        value={draft.fieldMinMt}
        onChange={(event) => onUpdate({ fieldMinMt: event.target.value })}
      />
      <FormField
        label="Maximum field"
        unit="mT"
        value={draft.fieldMaxMt}
        onChange={(event) => onUpdate({ fieldMaxMt: event.target.value })}
      />
      <FormField
        label="Field step"
        unit="mT"
        value={draft.fieldStepMt}
        onChange={(event) => onUpdate({ fieldStepMt: event.target.value })}
      />
      {draft.fieldScheduleMode === "piecewise" ? (
        <HysteresisFieldSegmentsEditor draft={draft} onUpdate={onUpdate} />
      ) : null}
      <FormField
        label="Field segments JSON"
        rows={5}
        type="textarea"
        value={draft.fieldSegments}
        onChange={(event) => onUpdate({ fieldSegments: event.target.value })}
      />
      <HysteresisDenseWindowsEditor draft={draft} onUpdate={onUpdate} />
      <FormField
        label="Dense windows JSON"
        rows={5}
        type="textarea"
        value={draft.denseWindows}
        onChange={(event) => onUpdate({ denseWindows: event.target.value })}
      />
      <FormField
        label="Saturation mode"
        type="select"
        value={draft.saturationMode}
        onChange={(event) => onUpdate({ saturationMode: event.target.value })}
      >
        <option value="none">None</option>
        <option value="auto">Auto detect</option>
      </FormField>
      {draft.saturationMode === "auto" ? (
        <>
          <FormField
            label="Max probe field"
            unit="mT"
            value={draft.maxProbeField}
            onChange={(event) =>
              onUpdate({ maxProbeField: event.target.value })
            }
          />
          <FormField
            label="Saturation thresholds"
            value={draft.saturationThresholds}
            onChange={(event) =>
              onUpdate({ saturationThresholds: event.target.value })
            }
          />
        </>
      ) : null}
      <FormField
        label="Settle pipeline"
        type="select"
        value={draft.settlePipelineMode}
        onChange={(event) =>
          onUpdate({ settlePipelineMode: event.target.value })
        }
      >
        <option value="sequence">Sequence</option>
        <option value="tree">Tree</option>
      </FormField>
      <HysteresisSettleAlgorithmsEditor
        algorithmsAvailable={algorithmsAvailable}
        draft={draft}
        onUpdate={onUpdate}
      />
      <FormField
        label="Settle steps"
        rows={5}
        type="textarea"
        value={draft.settleSteps}
        onChange={(event) => onUpdate({ settleSteps: event.target.value })}
      />
      {draft.settlePipelineMode === "tree" ? (
        <HysteresisSettleBranchesEditor draft={draft} onUpdate={onUpdate} />
      ) : null}
      <HysteresisMinorLoopsEditor draft={draft} onUpdate={onUpdate} />
      <FormField
        label="Storage policy"
        rows={5}
        type="textarea"
        value={draft.storagePolicy}
        onChange={(event) => onUpdate({ storagePolicy: event.target.value })}
      />
      <FormField
        checked={draft.storageEstimateAcknowledged}
        label="Storage estimate acknowledged"
        type="checkbox"
        onChange={(event) =>
          onUpdate({ storageEstimateAcknowledged: event.target.checked })
        }
      />
      <FormField
        label="Torque tol"
        unit="A/m"
        hint="Canonical maximum |m × H_eff| threshold. Tesla is display-only via μ₀ conversion."
        value={draft.torqueTolerance}
        onChange={(event) => onUpdate({ torqueTolerance: event.target.value })}
      />
    </>
  );
}

function hysteresisSettleBranchKey(branch: HysteresisSettleBranchDraft): string {
  return `settle-branch:${branch.branchId}:${branch.when}`;
}

function hysteresisMinorLoopKey(loop: HysteresisMinorLoopDraft): string {
  return `minor-loop:${loop.reversalField}:${loop.returnField}:${loop.parentBranch}`;
}

function hysteresisFieldSegmentKey(
  segment: HysteresisFieldSegmentDraft,
): string {
  return `field-segment:${segment.segmentId}:${segment.startField}:${segment.stopField}`;
}

function hysteresisDenseWindowKey(
  window: HysteresisDenseWindowDraft,
): string {
  return `dense-window:${window.centerField}:${window.halfWidth}:${window.priority}`;
}

function hysteresisSettleStepKey(step: HysteresisSettleStepDraft): string {
  return `settle-step:${String(step.step_id ?? "")}:${String(step.kind ?? "")}:${String(step.method ?? "")}:${String(step.applies_to ?? "")}`;
}

export function HysteresisSettleBranchesEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const branches = parseHysteresisSettleBranches(draft.settleBranches);
  const commitBranches = (nextBranches: HysteresisSettleBranchDraft[]) => {
    onUpdate({
      settleBranches: JSON.stringify(
        nextBranches.map((branch) => ({
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
        <div
          className="fm-inspector-form-section"
          key={hysteresisSettleBranchKey(branch)}
        >
          <div className="fm-inspector-form-section__header">
            <strong>Branch {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label="Remove settle branch"
                disabled={branches.length <= 1}
                size="icon"
                title="Remove settle branch"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitBranches(
                    branches.filter(
                      (_, branchIndex) => branchIndex !== index,
                    ),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <FormField
            label="Branch ID"
            value={branch.branchId}
            onChange={(event) =>
              updateBranch(index, { branchId: event.target.value })
            }
          />
          <FormField
            label="Trigger"
            type="select"
            value={branch.when}
            onChange={(event) =>
              updateBranch(index, { when: event.target.value })
            }
          >
            <option value="non_converged">Non-converged fallback</option>
            <option value="fallback">Fallback</option>
            <option value="run_next_algorithm">Run next algorithm</option>
            <option value="always">Always</option>
          </FormField>
          <FormField
            label="Run step JSON"
            rows={5}
            type="textarea"
            value={branch.run}
            onChange={(event) =>
              updateBranch(index, { run: event.target.value })
            }
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

export function HysteresisMinorLoopsEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const loops = parseHysteresisMinorLoops(draft.minorLoops);
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
        <div
          className="fm-inspector-form-section"
          key={hysteresisMinorLoopKey(loop)}
        >
          <div className="fm-inspector-form-section__header">
            <strong>Loop {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label="Remove minor loop"
                disabled={loops.length <= 1}
                size="icon"
                title="Remove minor loop"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitLoops(
                    loops.filter((_, loopIndex) => loopIndex !== index),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <FormField
            label="Reversal field"
            unit="mT"
            value={loop.reversalField}
            onChange={(event) =>
              updateLoop(index, { reversalField: event.target.value })
            }
          />
          <FormField
            label="Return field"
            unit="mT"
            value={loop.returnField}
            onChange={(event) =>
              updateLoop(index, { returnField: event.target.value })
            }
          />
          <FormField
            label="Parent branch"
            type="select"
            value={loop.parentBranch}
            onChange={(event) =>
              updateLoop(index, { parentBranch: event.target.value })
            }
          >
            <option value="descending">Descending</option>
            <option value="ascending">Ascending</option>
            <option value="major">Major</option>
          </FormField>
          <FormField
            label="Closure policy"
            type="select"
            value={loop.closurePolicy}
            onChange={(event) =>
              updateLoop(index, { closurePolicy: event.target.value })
            }
          >
            <option value="branch_only">Branch only</option>
            <option value="resume_parent">Resume parent</option>
            <option value="closed">Closed</option>
          </FormField>
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => commitLoops([...loops, defaultHysteresisMinorLoop(loops.length, draft)])}
        >
          <Plus size={13} aria-hidden="true" />
          <span>Add minor loop</span>
        </Button>
      </div>
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
  const segments = parseHysteresisFieldSegments(draft.fieldSegments);
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
        <div
          className="fm-inspector-form-section"
          key={hysteresisFieldSegmentKey(segment)}
        >
          <div className="fm-inspector-form-section__header">
            <strong>Segment {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label="Remove segment"
                disabled={segments.length <= 1}
                size="icon"
                title="Remove segment"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitSegments(
                    segments.filter(
                      (_, segmentIndex) => segmentIndex !== index,
                    ),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <FormField
            label="Segment ID"
            value={segment.segmentId}
            onChange={(event) =>
              updateSegment(index, { segmentId: event.target.value })
            }
          />
          <FormField
            label="Label"
            value={segment.label}
            onChange={(event) =>
              updateSegment(index, { label: event.target.value })
            }
          />
          <FormField
            label="Start field"
            unit="mT"
            value={segment.startField}
            onChange={(event) =>
              updateSegment(index, { startField: event.target.value })
            }
          />
          <FormField
            label="Stop field"
            unit="mT"
            value={segment.stopField}
            onChange={(event) =>
              updateSegment(index, { stopField: event.target.value })
            }
          />
          <FormField
            label="Step"
            unit="mT"
            value={segment.step}
            onChange={(event) =>
              updateSegment(index, { step: event.target.value })
            }
          />
          <FormField
            label="Endpoint policy"
            type="select"
            value={segment.endpointPolicy}
            onChange={(event) =>
              updateSegment(index, { endpointPolicy: event.target.value })
            }
          >
            <option value="include_stop">Include stop</option>
            <option value="skip_start">Skip start</option>
            <option value="include_both">Include both</option>
          </FormField>
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
  const windows = parseHysteresisDenseWindows(draft.denseWindows);
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
        <strong>Dense refinement windows</strong>
      </div>
      {windows.map((window, index) => (
        <div
          className="fm-inspector-form-section"
          key={hysteresisDenseWindowKey(window)}
        >
          <div className="fm-inspector-form-section__header">
            <strong>Window {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label="Remove dense window"
                disabled={windows.length <= 1}
                size="icon"
                title="Remove dense window"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitWindows(
                    windows.filter(
                      (_, windowIndex) => windowIndex !== index,
                    ),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <FormField
            label="Center field"
            unit="mT"
            value={window.centerField}
            onChange={(event) =>
              updateWindow(index, { centerField: event.target.value })
            }
          />
          <FormField
            label="Half width"
            unit="mT"
            value={window.halfWidth}
            onChange={(event) =>
              updateWindow(index, { halfWidth: event.target.value })
            }
          />
          <FormField
            label="Step"
            unit="mT"
            value={window.step}
            onChange={(event) =>
              updateWindow(index, { step: event.target.value })
            }
          />
          <FormField
            label="Priority"
            value={window.priority}
            onChange={(event) =>
              updateWindow(index, { priority: event.target.value })
            }
          />
          <FormField
            label="Reason"
            value={window.reason}
            onChange={(event) =>
              updateWindow(index, { reason: event.target.value })
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

export function HysteresisSettleAlgorithmsEditor({
  draft,
  onUpdate,
}: {
  algorithmsAvailable?: readonly string[];
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const steps = parseHysteresisSettleSteps(draft.settleSteps);
  const commitSteps = (nextSteps: HysteresisSettleStepDraft[]) => {
    onUpdate({
      settleSteps: JSON.stringify(
        nextSteps.map((step) => {
          const serializedStep: Record<string, unknown> = {
            step_id: step.step_id,
            kind: step.kind,
            method: step.method,
            on_non_convergence: step.on_non_convergence,
          };
          copyDefinedSettleStepValue(step, serializedStep, "alpha", Number);
          copyDefinedSettleStepValue(step, serializedStep, "damping", Number);
          copyDefinedSettleStepValue(
            step,
            serializedStep,
            "torque_tolerance",
            Number,
          );
          copyDefinedSettleStepValue(
            step,
            serializedStep,
            "energy_tolerance",
            Number,
          );
          copyDefinedSettleStepValue(step, serializedStep, "max_steps", Number);
          copyDefinedSettleStepValue(
            step,
            serializedStep,
            "timestep_s",
            Number,
          );
          copyDefinedSettleStepValue(
            step,
            serializedStep,
            "retry_timestep_scale",
            Number,
          );
          copyDefinedSettleStepValue(
            step,
            serializedStep,
            "retry_max_attempts",
            Number,
          );
          if (step.applies_to != null) {
            serializedStep.applies_to = parseJsonObjectOrString(
              String(step.applies_to),
            );
          }
          if (step.stop_criteria != null) {
            serializedStep.stop_criteria = parseJsonObjectOrString(
              String(step.stop_criteria),
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
    const temp = nextSteps[index];
    nextSteps[index] = nextSteps[targetIndex];
    nextSteps[targetIndex] = temp;
    commitSteps(nextSteps);
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Settle algorithms</strong>
      </div>
      {steps.map((step, index) => {
        const stepKind = step.kind || "relax";
        return (
          <div
            className="fm-inspector-form-section"
            key={hysteresisSettleStepKey(step)}
          >
            <div className="fm-inspector-form-section__header">
              <strong>Algorithm {index + 1}</strong>
              <div className="fm-inspector-toolbar">
                <Button
                  aria-label="Move algorithm up"
                  disabled={index === 0}
                  size="icon"
                  title="Move up"
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
                  title="Move down"
                  type="button"
                  variant="ghost"
                  onClick={() => moveStep(index, "down")}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </Button>
                <Button
                  aria-label="Remove algorithm"
                  disabled={steps.length <= 1}
                  size="icon"
                  title="Remove algorithm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    commitSteps(
                      steps.filter((_, stepIndex) => stepIndex !== index),
                    )
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
            </div>
            <FormField
              label="Step ID"
              value={String(step.step_id ?? "")}
              onChange={(event) =>
                updateStep(index, { step_id: event.target.value })
              }
            />
            <FormField
              label="Kind"
              type="select"
              value={stepKind}
              onChange={(event) => {
                const nextKind = event.target.value;
                const defaults =
                  nextKind === "relax"
                    ? DEFAULT_RELAX_SETTLE_STEP
                    : nextKind === "minimize"
                      ? DEFAULT_MINIMIZE_SETTLE_STEP
                      : DEFAULT_DYNAMICS_SETTLE_STEP;
                updateStep(index, {
                  ...defaults,
                  kind: nextKind,
                  step_id: step.step_id,
                });
              }}
            >
              <option value="relax">Relaxation</option>
              <option value="minimize">Energy minimization</option>
              <option value="dynamics_settle">Dynamics settle</option>
            </FormField>
            <FormField
              label="Method"
              type="select"
              value={String(step.method ?? "")}
              onChange={(event) =>
                updateStep(index, { method: event.target.value })
              }
            >
              {hysteresisSettleMethodOptions(stepKind).map((option) => (
                <option key={option} value={option}>
                  {hysteresisSettleMethodLabel(option)}
                </option>
              ))}
            </FormField>
            {stepKind === "relax" ? (
              <>
                <FormField
                  label="Alpha"
                  type="number"
                  value={String(step.alpha ?? "")}
                  onChange={(event) =>
                    updateStep(index, { alpha: event.target.value })
                  }
                />
                <FormField
                  label="Torque tolerance"
                  value={String(step.torque_tolerance ?? "")}
                  onChange={(event) =>
                    updateStep(index, { torque_tolerance: event.target.value })
                  }
                />
              </>
            ) : null}
            {stepKind === "minimize" ? (
              <FormField
                label="Energy tolerance"
                value={String(step.energy_tolerance ?? "")}
                onChange={(event) =>
                  updateStep(index, { energy_tolerance: event.target.value })
                }
              />
            ) : null}
            {stepKind === "dynamics_settle" ? (
              <>
                <FormField
                  label="Damping"
                  type="number"
                  value={String(step.damping ?? "")}
                  onChange={(event) =>
                    updateStep(index, { damping: event.target.value })
                  }
                />
                <FormField
                  label="Timestep"
                  value={String(step.timestep_s ?? "")}
                  onChange={(event) =>
                    updateStep(index, { timestep_s: event.target.value })
                  }
                />
                <FormField
                  label="Retry scale"
                  type="number"
                  value={String(step.retry_timestep_scale ?? "")}
                  onChange={(event) =>
                    updateStep(index, {
                      retry_timestep_scale: event.target.value,
                    })
                  }
                />
                <FormField
                  label="Retry attempts"
                  type="number"
                  value={String(step.retry_max_attempts ?? "")}
                  onChange={(event) =>
                    updateStep(index, {
                      retry_max_attempts: event.target.value,
                    })
                  }
                />
              </>
            ) : null}
            <FormField
              label="Max steps"
              type="number"
              value={String(step.max_steps ?? "")}
              onChange={(event) =>
                updateStep(index, { max_steps: event.target.value })
              }
            />
            <FormField
              label="Applies to"
              value={formatHysteresisSettleJsonishValue(step.applies_to)}
              onChange={(event) =>
                updateStep(index, {
                  applies_to: parseHysteresisSettleJsonishValue(
                    event.target.value,
                  ),
                })
              }
            />
            <FormField
              label="Stop criteria"
              value={formatHysteresisSettleJsonishValue(step.stop_criteria)}
              onChange={(event) =>
                updateStep(index, {
                  stop_criteria: parseHysteresisSettleJsonishValue(
                    event.target.value,
                  ),
                })
              }
            />
            <FormField
              label="On non-convergence"
              type="select"
              value={String(step.on_non_convergence ?? "")}
              onChange={(event) =>
                updateStep(index, { on_non_convergence: event.target.value })
              }
            >
              <option value="continue_with_warning">
                Continue with warning
              </option>
              <option value="fail_run">Fail stage run</option>
              <option value="abort_simulation">Abort simulation</option>
            </FormField>
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

// ── Parsing and utility functions ──

export function parseHysteresisSettleSteps(value: string | null | undefined): HysteresisSettleStepDraft[] {
  try {
    const raw = value ? JSON.parse(value) : null;
    if (Array.isArray(raw)) {
      return raw.map((item) => {
        const step: HysteresisSettleStepDraft = {};
        if (isRecord(item)) {
          step.step_id = stringFromUnknown(item.step_id, "");
          step.kind = stringFromUnknown(item.kind, "relax");
          step.method = stringFromUnknown(item.method, "");
          step.on_non_convergence = stringFromUnknown(
            item.on_non_convergence,
            "continue_with_warning",
          );
          normalizeHysteresisSettleStepPatch(item, step, "alpha");
          normalizeHysteresisSettleStepPatch(item, step, "damping");
          normalizeHysteresisSettleStepPatch(item, step, "torque_tolerance");
          normalizeHysteresisSettleStepPatch(item, step, "energy_tolerance");
          normalizeHysteresisSettleStepPatch(item, step, "max_steps");
          normalizeHysteresisSettleStepPatch(item, step, "timestep_s");
          normalizeHysteresisSettleStepPatch(item, step, "retry_timestep_scale");
          normalizeHysteresisSettleStepPatch(item, step, "retry_max_attempts");
          if (item.applies_to != null) {
            step.applies_to = item.applies_to;
          }
          if (item.stop_criteria != null) {
            step.stop_criteria = item.stop_criteria;
          }
        }
        return step;
      });
    }
  } catch {
    // Return default fallback below
  }
  return [{ ...DEFAULT_RELAX_SETTLE_STEP, step_id: "relax-1" }];
}

export function parseHysteresisFieldSegments(
  value: string | null | undefined,
): HysteresisFieldSegmentDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [defaultHysteresisFieldSegment(0)];
    const segments = parsed.flatMap((segment) =>
      isRecord(segment) ? [normalizeHysteresisFieldSegment(segment, 0)] : [],
    );
    return segments.length > 0 ? segments : [defaultHysteresisFieldSegment(0)];
  } catch {
    return [defaultHysteresisFieldSegment(0)];
  }
}

function normalizeHysteresisFieldSegment(
  segment: Record<string, unknown>,
  index: number,
): HysteresisFieldSegmentDraft {
  return {
    endpointPolicy: stringFromUnknown(
      segment.endpointPolicy ?? segment.endpoint_policy,
      "include_both",
    ),
    label: stringFromUnknown(segment.label, `Segment ${index + 1}`),
    reason: stringFromUnknown(segment.reason, ""),
    segmentId: stringFromUnknown(
      segment.segmentId ?? segment.segment_id,
      `seg-${index + 1}`,
    ),
    startField: stringFromUnknown(
      segment.startField ?? segment.start_field ?? segment.start,
      "0",
    ),
    step: stringFromUnknown(segment.step, "0.1"),
    stopField: stringFromUnknown(
      segment.stopField ?? segment.stop_field ?? segment.stop,
      "1.0",
    ),
    unit: stringFromUnknown(segment.unit, "T"),
  };
}

function defaultHysteresisFieldSegment(
  index: number,
): HysteresisFieldSegmentDraft {
  return {
    endpointPolicy: "include_both",
    label: `Segment ${index + 1}`,
    reason: "",
    segmentId: `seg-${index + 1}`,
    startField: "0",
    step: "0.1",
    stopField: "1.0",
    unit: "T",
  };
}

export function parseHysteresisDenseWindows(
  value: string | null | undefined,
): HysteresisDenseWindowDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [defaultHysteresisDenseWindow(0)];
    let index = 0;
    const windows = parsed.flatMap((window) => {
      if (!isRecord(window)) return [];
      const normalized = normalizeHysteresisDenseWindow(window, index);
      index += 1;
      return [normalized];
    });
    return windows.length > 0 ? windows : [defaultHysteresisDenseWindow(0)];
  } catch {
    return [defaultHysteresisDenseWindow(0)];
  }
}

function normalizeHysteresisDenseWindow(
  window: Record<string, unknown>,
  index: number,
): HysteresisDenseWindowDraft {
  return {
    centerField: stringFromUnknown(
      window.centerField ?? window.center_mT ?? window.center,
      "0",
    ),
    halfWidth: stringFromUnknown(
      window.halfWidth ??
        window.halfWidthMt ??
        window.half_width_mT ??
        window.half_width,
      "",
    ),
    priority: stringFromUnknown(window.priority, String(index + 1)),
    reason: stringFromUnknown(window.reason, ""),
    step: stringFromUnknown(window.step ?? window.stepMt ?? window.step_mT, ""),
  };
}

function defaultHysteresisDenseWindow(
  index: number,
  draft?: StudyStageDraft,
): HysteresisDenseWindowDraft {
  return {
    centerField: "0",
    halfWidth: "",
    priority: String(index + 1),
    reason: index === 0 ? "remanence" : "",
    step: draft?.fieldStepMt ?? "",
  };
}

export function parseHysteresisMinorLoops(value: string | null | undefined): HysteresisMinorLoopDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [defaultHysteresisMinorLoop(0)];
    const loops = parsed.flatMap((loop) =>
      isRecord(loop) ? [normalizeHysteresisMinorLoop(loop)] : [],
    );
    return loops.length > 0 ? loops : [defaultHysteresisMinorLoop(0)];
  } catch {
    return [defaultHysteresisMinorLoop(0)];
  }
}

export function parseHysteresisSettleBranches(
  value: string | null | undefined,
): HysteresisSettleBranchDraft[] {
  try {
    const parsed = value ? JSON.parse(value) : null;
    if (!Array.isArray(parsed)) return [defaultHysteresisSettleBranch(0)];
    let branchIndex = 0;
    const branches = parsed.flatMap((branch) => {
      if (!isRecord(branch)) return [];
      const normalized = normalizeHysteresisSettleBranch(branch, branchIndex);
      branchIndex += 1;
      return [normalized];
    });
    return branches.length > 0 ? branches : [defaultHysteresisSettleBranch(0)];
  } catch {
    return [defaultHysteresisSettleBranch(0)];
  }
}

function normalizeHysteresisSettleBranch(
  branch: Record<string, unknown>,
  index: number,
): HysteresisSettleBranchDraft {
  return {
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
    branchId:
      index === 0 ? "non_converged_fallback" : `settle_branch_${index + 1}`,
    run: JSON.stringify(DEFAULT_RELAX_SETTLE_STEP),
    when: index === 0 ? "non_converged" : "always",
  };
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

function normalizeHysteresisMinorLoop(
  loop: Record<string, unknown>,
): HysteresisMinorLoopDraft {
  return {
    closurePolicy: stringFromUnknown(
      loop.closurePolicy ?? loop.closure_policy,
      "branch_only",
    ),
    parentBranch: stringFromUnknown(
      loop.parentBranch ?? loop.parent_branch,
      "descending",
    ),
    returnField: stringFromUnknown(
      loop.returnField ?? loop.returnMt ?? loop.return_mT,
      "",
    ),
    reversalField: stringFromUnknown(
      loop.reversalField ?? loop.reversalMt ?? loop.reversal_mT,
      "",
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
    closurePolicy: "branch_only",
    parentBranch: "descending",
    returnField: String(-offset * (index + 1)),
    reversalField: String(offset * (index + 1)),
  };
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
      if (!isNaN(parsedValue)) {
        target[field] = parsedValue;
      } else {
        target[field] = stringValue;
      }
    }
  }
}

function hysteresisSettleMethodOptions(kind?: string) {
  if (kind === "minimize") {
    return [
      "projected_gradient_bb",
      "conjugate_gradient_pr",
      "lbfgs_bounded",
      "newton_cg",
    ];
  }
  if (kind === "dynamics_settle") {
    return [
      "heun_dynamics_settle",
      "rk4_dynamics_settle",
      "backward_euler_dynamics_settle",
    ];
  }
  return ["llg_overdamped", "llg_critically_damped", "direct_relaxation"];
}

function hysteresisSettleMethodLabel(method: string): string {
  return method === "projected_gradient_bb" ? "Projected gradient BB" : method;
}

function formatHysteresisSettleJsonishValue(value: unknown): string {
  return stringifyJsonDraftValue(value, "{}");
}

function parseHysteresisSettleJsonishValue(value: string): unknown {
  return parseJsonObjectOrString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
