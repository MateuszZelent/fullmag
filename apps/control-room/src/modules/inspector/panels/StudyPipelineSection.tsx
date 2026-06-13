import {
  Activity,
  ArrowDown,
  ArrowUp,
  Copy,
  Gauge,
  Plus,
  Save,
  Sigma,
  Trash2,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";

import {
  validateStudyStageDraft,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "./StudyStageAuthoringModel";
import type {
  StudyInspectorModel,
  StudyStageModel,
} from "./StudyInspectorPanelModel";
import { StudyProgressBar } from "./StudyProgressBar";

type HysteresisSettleStepDraft = {
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

const DEFAULT_RELAX_SETTLE_STEP: HysteresisSettleStepDraft = {
  kind: "relax",
  method: "llg_overdamped",
  alpha: 1,
  torque_tolerance: "1e-6",
  max_steps: 10000,
  on_non_convergence: "continue_with_warning",
};

const DEFAULT_MINIMIZE_SETTLE_STEP: HysteresisSettleStepDraft = {
  kind: "minimize",
  method: "projected_gradient_bb",
  energy_tolerance: "1e-20",
  max_steps: 200,
  on_non_convergence: "continue_with_warning",
};

const DEFAULT_DYNAMICS_SETTLE_STEP: HysteresisSettleStepDraft = {
  damping: 1,
  kind: "dynamics_settle",
  max_steps: 200,
  method: "heun_dynamics_settle",
  on_non_convergence: "continue_with_warning",
  timestep_s: "1e-12",
};

type StudyCommandRunner = (commandId: string, input?: unknown) => void;
type StudyCommandDisabledReason = (commandId: string) => string | null;

export function StudyPipelineSection({
  activeStageIndex,
  authoringBusy,
  authoringFeedback,
  commandDisabledReason,
  draft,
  draftIndex,
  drafts,
  model,
  onAddStage,
  onCommit,
  onDuplicateStage,
  onMoveStage,
  onRemoveStage,
  onSelectDraft,
  onUpdateDraft,
  runCommand,
  showDraftEditor = true,
}: {
  activeStageIndex: number | null;
  authoringBusy: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
  } | null;
  commandDisabledReason: StudyCommandDisabledReason;
  draft: StudyStageDraft | null;
  draftIndex: number;
  drafts: StudyStageDraft[];
  model: StudyInspectorModel;
  onAddStage: (kind: StudyStageDraftKind) => void;
  onCommit: () => void;
  onDuplicateStage: (index: number) => void;
  onMoveStage: (index: number, direction: -1 | 1) => void;
  onRemoveStage: (index: number) => void;
  onSelectDraft: (index: number) => void;
  onUpdateDraft: (index: number, patch: Partial<StudyStageDraft>) => void;
  runCommand: StudyCommandRunner;
  showDraftEditor?: boolean;
}) {
  const validation = draft ? validateStudyStageDraft(draft) : [];
  const hasDraftErrors = validation.some((issue) => issue.severity === "error");
  return (
    <InspectorSection
      value="pipeline"
      title="Stage Pipeline"
      badge={`${model.stages.length}`}
    >
      <div className="fm-study-stage-list">
        {model.stages.map((stage) => (
          <StageCard
            key={stage.index}
            active={activeStageIndex === stage.index}
            selected={draftIndex === stage.index}
            stage={stage}
            onSelect={() => onSelectDraft(stage.index)}
          />
        ))}
      </div>
      {showDraftEditor && draft ? (
        <StudyStageDraftEditor
          draft={draft}
          index={draftIndex}
          validation={validation}
          onUpdate={(patch) => onUpdateDraft(draftIndex, patch)}
        />
      ) : !showDraftEditor ? null : (
        <div className="fm-study-stage-empty">No stages configured.</div>
      )}
      {!showDraftEditor && hasDraftErrors ? (
        <FeedbackBanner
          kind="warning"
          message="Selected stage has validation errors. Open the stage node to edit its detailed settings."
        />
      ) : null}
      {authoringFeedback ? (
        <FeedbackBanner
          kind={authoringFeedback.kind}
          message={authoringFeedback.message}
        />
      ) : null}
      <div
        className="fm-inspector-toolbar"
        data-testid="study-stage-authoring-toolbar"
      >
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("relax")}
        >
          <Plus size={13} aria-hidden="true" />
          Relax
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("run")}
        >
          <Zap size={13} aria-hidden="true" />
          Run
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("eigenmodes")}
        >
          <Sigma size={13} aria-hidden="true" />
          Eigenmodes
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("frequency_response")}
        >
          <Activity size={13} aria-hidden="true" />
          Frequency
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("hysteresis")}
        >
          <Gauge size={13} aria-hidden="true" />
          Hysteresis
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("save_state")}
        >
          <Save size={13} aria-hidden="true" />
          Save
        </Button>
        <Button
          disabled={!draft}
          size="sm"
          title="Duplicate selected stage"
          type="button"
          variant="ghost"
          onClick={() => onDuplicateStage(draftIndex)}
        >
          <Copy size={13} aria-hidden="true" />
          Duplicate
        </Button>
        <Button
          disabled={!draft || draftIndex <= 0}
          size="icon"
          title="Move stage up"
          type="button"
          variant="ghost"
          onClick={() => onMoveStage(draftIndex, -1)}
        >
          <ArrowUp size={13} aria-hidden="true" />
        </Button>
        <Button
          disabled={!draft || draftIndex >= drafts.length - 1}
          size="icon"
          title="Move stage down"
          type="button"
          variant="ghost"
          onClick={() => onMoveStage(draftIndex, 1)}
        >
          <ArrowDown size={13} aria-hidden="true" />
        </Button>
        <Button
          disabled={!draft}
          size="sm"
          title="Remove selected stage"
          type="button"
          variant="danger"
          onClick={() => onRemoveStage(draftIndex)}
        >
          <Trash2 size={13} aria-hidden="true" />
          Remove
        </Button>
        <Button
          disabled={authoringBusy || hasDraftErrors}
          size="sm"
          title={
            hasDraftErrors
              ? "Fix stage validation errors before saving."
              : "Save stage pipeline"
          }
          type="button"
          variant="primary"
          onClick={onCommit}
        >
          <Save size={13} aria-hidden="true" />
          {authoringBusy ? "Saving" : "Save stages"}
        </Button>
      </div>
      <div className="fm-inspector-toolbar">
        <PipelineCommandButton
          commandId="study.compute-fields"
          disabledReason={commandDisabledReason("study.compute-fields")}
          icon={<Activity size={13} />}
          label="Fields"
          onRun={runCommand}
        />
        <PipelineCommandButton
          commandId="study.compute-energies"
          disabledReason={commandDisabledReason("study.compute-energies")}
          icon={<Sigma size={13} />}
          label="Energies"
          onRun={runCommand}
        />
      </div>
    </InspectorSection>
  );
}

function StageCard({
  active,
  selected,
  stage,
  onSelect,
}: {
  active: boolean;
  selected?: boolean;
  stage: StudyStageModel;
  onSelect?: () => void;
}) {
  const content = (
    <>
      <div className="fm-study-stage-card__header">
        <span>{stage.label}</span>
        <small>{stage.status}</small>
      </div>
      <StudyProgressBar
        label={`${stage.label} progress`}
        value={stage.progressPercent}
      />
      <div className="fm-study-stage-card__meta">
        {stage.torqueToleranceShortFormatted ? (
          <span>tau {stage.torqueToleranceShortFormatted}</span>
        ) : null}
        {stage.energyTolerance ? <span>E {stage.energyTolerance}</span> : null}
        {stage.maxSteps ? <span>{stage.maxSteps} steps</span> : null}
        {stage.untilSeconds ? <span>{stage.untilSeconds} s</span> : null}
      </div>
    </>
  );

  if (onSelect) {
    return (
      <button
        className="fm-study-stage-card"
        data-active={active ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        data-status={stage.status}
        type="button"
        onClick={onSelect}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className="fm-study-stage-card"
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-status={stage.status}
    >
      {content}
    </div>
  );
}

export function StudyStageDraftEditor({
  draft,
  index,
  onUpdate,
  validation,
}: {
  draft: StudyStageDraft;
  index: number;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  validation: readonly { message: string; severity: "error" | "warning" }[];
}) {
  return (
    <div className="fm-study-stage-editor">
      <div className="fm-study-stage-editor__header">
        <strong>
          Stage {index + 1}: {studyStageDraftKindLabel(draft.kind)}
        </strong>
        <span>
          {validation.length === 0 ? "valid" : `${validation.length} issue(s)`}
        </span>
      </div>
      {validation.length > 0 ? (
        <ul className="fm-inspector-validation-list">
          {validation.map((issue) => (
            <li key={`${issue.severity}:${issue.message}`}>
              {issue.severity}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <FormField
        label="Kind"
        type="select"
        value={draft.kind}
        onChange={(event) =>
          onUpdate({ kind: event.target.value as StudyStageDraftKind })
        }
      >
        <option value="relax">Relax</option>
        <option value="run">Run</option>
        <option value="hysteresis">Hysteresis</option>
        <option value="eigenmodes">Eigenmodes</option>
        <option value="frequency_response">Frequency response</option>
        <option value="save_state">Save state</option>
      </FormField>
      <FormField
        label="Stage ID"
        value={draft.stageId}
        onChange={(event) => onUpdate({ stageId: event.target.value })}
      />
      {draft.kind === "run" ? (
        <FormField
          label="Until"
          unit="s"
          value={draft.untilSeconds}
          onChange={(event) => onUpdate({ untilSeconds: event.target.value })}
        />
      ) : draft.kind === "hysteresis" ? (
        <HysteresisStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : draft.kind === "eigenmodes" ? (
        <EigenmodesStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : draft.kind === "frequency_response" ? (
        <FrequencyResponseStageDraftFields
          draft={draft}
          onUpdate={onUpdate}
        />
      ) : draft.kind === "save_state" ? (
        <SaveStateStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : (
        <RelaxStageDraftFields draft={draft} onUpdate={onUpdate} />
      )}
    </div>
  );
}

function studyStageDraftKindLabel(kind: StudyStageDraftKind): string {
  if (kind === "eigenmodes") return "Eigenmodes";
  if (kind === "frequency_response") return "Frequency Response";
  if (kind === "hysteresis") return "Hysteresis";
  if (kind === "save_state") return "Save State";
  if (kind === "run") return "Run";
  return "Relax";
}

function HysteresisStageDraftFields({
  draft,
  onUpdate,
}: {
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
        <FormField
          label="Field segments"
          rows={5}
          type="textarea"
          value={draft.fieldSegments}
          onChange={(event) =>
            onUpdate({ fieldSegments: event.target.value })
          }
        />
      ) : null}
      <FormField
        label="Dense windows"
        rows={4}
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
      <HysteresisSettleAlgorithmsEditor draft={draft} onUpdate={onUpdate} />
      <FormField
        label="Settle steps"
        rows={5}
        type="textarea"
        value={draft.settleSteps}
        onChange={(event) => onUpdate({ settleSteps: event.target.value })}
      />
      {draft.settlePipelineMode === "tree" ? (
        <FormField
          label="Settle branches"
          rows={5}
          type="textarea"
          value={draft.settleBranches}
          onChange={(event) =>
            onUpdate({ settleBranches: event.target.value })
          }
        />
      ) : null}
      <FormField
        label="Minor loops"
        rows={4}
        type="textarea"
        value={draft.minorLoops}
        onChange={(event) => onUpdate({ minorLoops: event.target.value })}
      />
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
        value={draft.torqueTolerance}
        onChange={(event) => onUpdate({ torqueTolerance: event.target.value })}
      />
    </>
  );
}

function HysteresisSettleAlgorithmsEditor({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const steps = parseHysteresisSettleSteps(draft.settleSteps);
  const commitSteps = (nextSteps: HysteresisSettleStepDraft[]) => {
    onUpdate({ settleSteps: JSON.stringify(nextSteps) });
  };
  const updateStep = (
    index: number,
    patch: Partial<HysteresisSettleStepDraft>,
  ) => {
    commitSteps(
      steps.map((step, stepIndex) =>
        stepIndex === index
          ? normalizeHysteresisSettleStepPatch({ ...step, ...patch })
          : step,
      ),
    );
  };
  const moveStep = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= steps.length) return;
    const nextSteps = [...steps];
    const [step] = nextSteps.splice(index, 1);
    nextSteps.splice(nextIndex, 0, step);
    commitSteps(nextSteps);
  };

  return (
    <div className="fm-inspector-form-section">
      <div className="fm-inspector-form-section__header">
        <strong>Settle algorithms</strong>
      </div>
      {steps.map((step, index) => (
        <div className="fm-inspector-form-section" key={index}>
          <div className="fm-inspector-form-section__header">
            <strong>Algorithm {index + 1}</strong>
            <div className="fm-inspector-toolbar">
              <Button
                aria-label="Move algorithm up"
                disabled={index === 0}
                size="icon"
                title="Move algorithm up"
                type="button"
                variant="ghost"
                onClick={() => moveStep(index, -1)}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </Button>
              <Button
                aria-label="Move algorithm down"
                disabled={index === steps.length - 1}
                size="icon"
                title="Move algorithm down"
                type="button"
                variant="ghost"
                onClick={() => moveStep(index, 1)}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  commitSteps(
                    steps.filter((_, stepIndex) => stepIndex !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
          </div>
          <FormField
            label="Kind"
            type="select"
            value={step.kind ?? "relax"}
            onChange={(event) => {
              const kind = event.target.value;
              updateStep(
                index,
                kind === "dynamics_settle"
                  ? DEFAULT_DYNAMICS_SETTLE_STEP
                  : kind === "minimize"
                    ? DEFAULT_MINIMIZE_SETTLE_STEP
                    : DEFAULT_RELAX_SETTLE_STEP,
              );
            }}
          >
            <option value="relax">Relax</option>
            <option value="minimize">Minimize</option>
            <option value="dynamics_settle">Dynamics settle</option>
          </FormField>
          <FormField
            label="Step ID"
            value={String(step.step_id ?? "")}
            onChange={(event) =>
              updateStep(index, { step_id: event.target.value })
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
            label="Method"
            type="select"
            value={step.method ?? defaultHysteresisSettleMethod(step.kind)}
            onChange={(event) =>
              updateStep(index, { method: event.target.value })
            }
          >
            {hysteresisSettleMethodOptions(step.kind).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FormField>
          <FormField
            label="Torque tolerance"
            value={String(step.torque_tolerance ?? "")}
            onChange={(event) =>
              updateStep(index, { torque_tolerance: event.target.value })
            }
          />
          <FormField
            label="Energy tolerance"
            unit="J"
            value={String(step.energy_tolerance ?? "")}
            onChange={(event) =>
              updateStep(index, { energy_tolerance: event.target.value })
            }
          />
          <FormField
            label="Max steps"
            value={String(step.max_steps ?? "")}
            onChange={(event) =>
              updateStep(index, { max_steps: event.target.value })
            }
          />
          {step.kind === "relax" ? (
            <FormField
              label="Alpha"
              value={String(step.alpha ?? "")}
              onChange={(event) =>
                updateStep(index, { alpha: event.target.value })
              }
            />
          ) : null}
          {step.kind === "dynamics_settle" ? (
            <FormField
              label="Damping"
              value={String(step.damping ?? "")}
              onChange={(event) =>
                updateStep(index, { damping: event.target.value })
              }
            />
          ) : null}
          <FormField
            label="Timestep"
            unit="s"
            value={String(step.timestep_s ?? "")}
            onChange={(event) =>
              updateStep(index, { timestep_s: event.target.value })
            }
          />
          <FormField
            label="Stop criteria"
            rows={3}
            type="textarea"
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
            value={step.on_non_convergence ?? "continue_with_warning"}
            onChange={(event) =>
              updateStep(index, { on_non_convergence: event.target.value })
            }
          >
            <option value="continue_with_warning">Continue with warning</option>
            <option value="stop_stage">Stop stage</option>
            <option value="run_next_algorithm">Run next algorithm</option>
            <option value="retry_with_smaller_dt">Retry with smaller dt</option>
          </FormField>
          <FormField
            label="Retry scale"
            value={String(step.retry_timestep_scale ?? "")}
            onChange={(event) =>
              updateStep(index, { retry_timestep_scale: event.target.value })
            }
          />
          <FormField
            label="Retry attempts"
            value={String(step.retry_max_attempts ?? "")}
            onChange={(event) =>
              updateStep(index, { retry_max_attempts: event.target.value })
            }
          />
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          onClick={() => commitSteps([...steps, DEFAULT_RELAX_SETTLE_STEP])}
        >
          Add relax
        </Button>
        <Button
          size="sm"
          type="button"
          onClick={() => commitSteps([...steps, DEFAULT_MINIMIZE_SETTLE_STEP])}
        >
          Add minimize
        </Button>
        <Button
          size="sm"
          type="button"
          onClick={() =>
            commitSteps([...steps, DEFAULT_DYNAMICS_SETTLE_STEP])
          }
        >
          Add dynamics
        </Button>
      </div>
    </div>
  );
}

function parseHysteresisSettleSteps(value: string): HysteresisSettleStepDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [DEFAULT_RELAX_SETTLE_STEP];
    const steps = parsed
      .filter((step): step is Record<string, unknown> => isRecord(step))
      .map((step) => normalizeHysteresisSettleStepPatch(step));
    return steps.length > 0 ? steps : [DEFAULT_RELAX_SETTLE_STEP];
  } catch {
    return [DEFAULT_RELAX_SETTLE_STEP];
  }
}

function normalizeHysteresisSettleStepPatch(
  step: Record<string, unknown>,
): HysteresisSettleStepDraft {
  const kind =
    step.kind === "dynamics_settle"
      ? "dynamics_settle"
      : step.kind === "minimize"
        ? "minimize"
        : "relax";
  const method =
    typeof step.method === "string" && step.method
      ? step.method
      : defaultHysteresisSettleMethod(kind);
  const normalized: HysteresisSettleStepDraft = { ...step, kind, method };
  removeEmptySettleStepValue(normalized, "step_id");
  copyDefinedSettleStepValue(step, normalized, "alpha");
  copyDefinedSettleStepValue(step, normalized, "damping");
  copyDefinedSettleStepValue(step, normalized, "torque_tolerance");
  copyDefinedSettleStepValue(step, normalized, "energy_tolerance");
  copyDefinedSettleStepValue(step, normalized, "max_steps");
  copyDefinedSettleStepValue(step, normalized, "timestep_s");
  copyDefinedSettleStepValue(step, normalized, "retry_timestep_scale");
  copyDefinedSettleStepValue(step, normalized, "retry_max_attempts");
  copyDefinedSettleStepValue(step, normalized, "on_non_convergence");
  removeEmptySettleStepValue(normalized, "applies_to");
  removeEmptySettleStepValue(normalized, "stop_criteria");
  return normalized;
}

function copyDefinedSettleStepValue(
  source: Record<string, unknown>,
  target: HysteresisSettleStepDraft,
  key: keyof HysteresisSettleStepDraft,
) {
  const value = source[key];
  if (key === "kind" || key === "method" || key === "on_non_convergence") {
    if (typeof value === "string") target[key] = value;
    return;
  }
  if (typeof value === "string" || typeof value === "number") {
    target[key] = value;
  }
}

function removeEmptySettleStepValue(
  target: HysteresisSettleStepDraft,
  key: keyof HysteresisSettleStepDraft,
) {
  if (target[key] === "") delete target[key];
}

function defaultHysteresisSettleMethod(kind?: string): string {
  if (kind === "dynamics_settle") return "heun_dynamics_settle";
  return kind === "minimize" ? "projected_gradient_bb" : "llg_overdamped";
}

function hysteresisSettleMethodOptions(kind?: string) {
  if (kind === "dynamics_settle") {
    return [{ value: "heun_dynamics_settle", label: "Heun dynamics settle" }];
  }
  if (kind === "minimize") {
    return [{ value: "projected_gradient_bb", label: "Projected gradient BB" }];
  }
  return [
    { value: "llg_overdamped", label: "LLG overdamped" },
    { value: "projected_gradient_bb", label: "Projected gradient BB" },
    { value: "nonlinear_cg", label: "Nonlinear CG" },
    { value: "tangent_plane_implicit", label: "Tangent-plane implicit" },
  ];
}

function formatHysteresisSettleJsonishValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

function parseHysteresisSettleJsonishValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function RelaxStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Algorithm"
        type="select"
        value={draft.algorithm}
        onChange={(event) => onUpdate({ algorithm: event.target.value })}
      >
        <option value="llg_overdamped">LLG overdamped</option>
        <option value="projected_gradient_bb">Projected gradient BB</option>
        <option value="nonlinear_cg">Nonlinear CG</option>
        <option value="tangent_plane_implicit">Tangent-plane implicit</option>
      </FormField>
      <FormField
        label="Torque tol"
        value={draft.torqueTolerance}
        onChange={(event) => onUpdate({ torqueTolerance: event.target.value })}
      />
      <FormField
        label="Energy tol"
        unit="J"
        value={draft.energyTolerance}
        onChange={(event) => onUpdate({ energyTolerance: event.target.value })}
      />
      <FormField
        label="Max steps"
        value={draft.maxSteps}
        onChange={(event) => onUpdate({ maxSteps: event.target.value })}
      />
      <FormField
        label="Pseudo time"
        unit="s"
        value={draft.maxPseudotime}
        onChange={(event) => onUpdate({ maxPseudotime: event.target.value })}
      />
      <FormField
        label="Physical time"
        unit="s"
        value={draft.maxPhysicalTime}
        onChange={(event) => onUpdate({ maxPhysicalTime: event.target.value })}
      />
      <FormField
        label="Relax alpha"
        value={draft.relaxAlpha}
        onChange={(event) => onUpdate({ relaxAlpha: event.target.value })}
      />
      <FormField
        label="Solver"
        type="select"
        value={draft.solver}
        onChange={(event) => onUpdate({ solver: event.target.value })}
      >
        <option value="">Default</option>
        <option value="rk23">RK23</option>
        <option value="rk45">RK45</option>
        <option value="heun">Heun</option>
        <option value="euler">Euler</option>
      </FormField>
      <FormField
        label="dt"
        value={draft.dt}
        onChange={(event) => onUpdate({ dt: event.target.value })}
      />
      <FormField
        label="dt min"
        unit="s"
        value={draft.dtMin}
        onChange={(event) => onUpdate({ dtMin: event.target.value })}
      />
      <FormField
        label="Max error"
        value={draft.maxError}
        onChange={(event) => onUpdate({ maxError: event.target.value })}
      />
      <FormField
        label="Field every"
        hint="Push field samples every N solver steps."
        value={draft.fieldEvery}
        onChange={(event) => onUpdate({ fieldEvery: event.target.value })}
      />
    </>
  );
}

function EigenmodesStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <SpectralStageDraftFields draft={draft} onUpdate={onUpdate} />
      <FormField
        label="Mode count"
        value={draft.count}
        onChange={(event) => onUpdate({ count: event.target.value })}
      />
      <FormField
        label="Target"
        type="select"
        value={draft.target}
        onChange={(event) => onUpdate({ target: event.target.value })}
      >
        <option value="lowest">Lowest</option>
        <option value="largest">Largest</option>
        <option value="near_frequency">Near frequency</option>
      </FormField>
      <FormField
        label="Target freq"
        unit="Hz"
        value={draft.targetFrequency}
        onChange={(event) => onUpdate({ targetFrequency: event.target.value })}
      />
    </>
  );
}

function FrequencyResponseStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <SpectralStageDraftFields draft={draft} onUpdate={onUpdate} />
      <FormField
        label="Frequencies"
        hint="Comma or whitespace separated values in Hz."
        value={draft.frequenciesHz}
        onChange={(event) => onUpdate({ frequenciesHz: event.target.value })}
      />
      <FormField
        label="Excitation"
        unit="A/m"
        value={draft.excitationField}
        onChange={(event) => onUpdate({ excitationField: event.target.value })}
      />
      <FormField
        label="Excitation phase"
        unit="rad"
        value={draft.excitationPhaseRad}
        onChange={(event) => onUpdate({ excitationPhaseRad: event.target.value })}
      />
      <FormField
        label="Observable"
        value={draft.observable}
        onChange={(event) => onUpdate({ observable: event.target.value })}
      />
    </>
  );
}

function SaveStateStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Artifact"
        value={draft.artifactName}
        onChange={(event) => onUpdate({ artifactName: event.target.value })}
      />
      <FormField
        label="Format"
        value={draft.format}
        onChange={(event) => onUpdate({ format: event.target.value })}
      />
      <FormField
        label="Dataset"
        value={draft.dataset}
        onChange={(event) => onUpdate({ dataset: event.target.value })}
      />
    </>
  );
}

function SpectralStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Include demag"
        checked={draft.includeDemag}
        type="checkbox"
        onChange={(event) => onUpdate({ includeDemag: event.target.checked })}
      />
      <FormField
        label="Equilibrium"
        type="select"
        value={draft.equilibriumSource}
        onChange={(event) =>
          onUpdate({ equilibriumSource: event.target.value })
        }
      >
        <option value="relax">Relax stage</option>
        <option value="provided">Provided artifact</option>
        <option value="current_state">Current state</option>
      </FormField>
      <FormField
        label="Eq artifact"
        value={draft.equilibriumArtifact}
        onChange={(event) =>
          onUpdate({ equilibriumArtifact: event.target.value })
        }
      />
      <FormField
        label="Normalization"
        type="select"
        value={draft.normalization}
        onChange={(event) => onUpdate({ normalization: event.target.value })}
      >
        <option value="unit_l2">Unit L2</option>
        <option value="max_component">Max component</option>
        <option value="none">None</option>
      </FormField>
      <FormField
        label="Damping"
        type="select"
        value={draft.dampingPolicy}
        onChange={(event) => onUpdate({ dampingPolicy: event.target.value })}
      >
        <option value="ignore">Ignore</option>
        <option value="linearized">Linearized</option>
        <option value="full">Full</option>
      </FormField>
      <FormField
        label="k vector"
        value={draft.kVector}
        onChange={(event) => onUpdate({ kVector: event.target.value })}
      />
      <FormField
        label="k sampling"
        hint="JSON object."
        type="textarea"
        rows={3}
        value={draft.kSampling}
        onChange={(event) => onUpdate({ kSampling: event.target.value })}
      />
      <FormField
        label="BC"
        hint="Boundary condition name or JSON object."
        value={draft.bc}
        onChange={(event) => onUpdate({ bc: event.target.value })}
      />
    </>
  );
}

function PipelineCommandButton({
  commandId,
  disabledReason,
  icon,
  label,
  onRun,
}: {
  commandId: string;
  disabledReason: string | null;
  icon: ReactNode;
  label: string;
  onRun: StudyCommandRunner;
}) {
  const enabled = disabledReason === null;
  return (
    <Button
      size="sm"
      type="button"
      variant="ghost"
      disabled={!enabled}
      aria-label={enabled ? label : `${label}: ${disabledReason}`}
      title={disabledReason ?? label}
      onClick={() => onRun(commandId)}
    >
      {icon}
      {label}
    </Button>
  );
}
