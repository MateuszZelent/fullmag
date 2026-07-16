import {
  Activity,
  ArrowDown,
  ArrowUp,
  Copy,
  Cpu,
  Gauge,
  Plus,
  Radio,
  Save,
  Sigma,
  Trash2,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";

import {
  relaxationAlgorithmAvailability,
  validateStudyStageDraft,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "./StudyStageAuthoringModel";
import type {
  StudyInspectorModel,
  StudyStageModel,
} from "./StudyInspectorPanelModel";
import { StudyProgressBar } from "./StudyProgressBar";
import type { FrequencyDomainAuthoringView } from "./stages/StageInspectorFrame";

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

type HysteresisFieldSegmentDraft = {
  segmentId: string;
  label: string;
  startField: string;
  stopField: string;
  step: string;
  unit: string;
  endpointPolicy: string;
  reason: string;
};

type HysteresisDenseWindowDraft = {
  centerField: string;
  halfWidth: string;
  step: string;
  priority: string;
  reason: string;
};

type HysteresisMinorLoopDraft = {
  reversalField: string;
  returnField: string;
  parentBranch: string;
  closurePolicy: string;
};

type HysteresisSettleBranchDraft = {
  branchId: string;
  when: string;
  run: string;
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
  algorithmsAvailable,
  authoringBusy,
  authoringFeedback,
  commandDisabledReason,
  demagEnabled = false,
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
  algorithmsAvailable?: readonly string[];
  authoringBusy: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
  } | null;
  commandDisabledReason: StudyCommandDisabledReason;
  demagEnabled?: boolean;
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
  const validation = draft
    ? validateStudyStageDraft(draft, {
        algorithmsAvailable,
        backend: model.requested.backend,
        demagEnabled,
        device: model.requested.device,
        mode: model.requested.mode,
      })
    : [];
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
          demagEnabled={demagEnabled}
          algorithmsAvailable={algorithmsAvailable}
          index={draftIndex}
          requestedBackend={model.requested.backend}
          requestedDevice={model.requested.device}
          requestedMode={model.requested.mode}
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
          onClick={() => onAddStage("add_field_drive")}
        >
          <Radio size={13} aria-hidden="true" />
          Antenna
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
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("change_device")}
        >
          <Cpu size={13} aria-hidden="true" />
          Device
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
        statusLabel={stage.progressLabel ?? undefined}
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
  algorithmsAvailable,
  draft,
  demagEnabled = false,
  index,
  onUpdate,
  requestedBackend = "auto",
  requestedDevice = "auto",
  requestedMode = "strict",
  validation,
  view = "overview",
}: {
  draft: StudyStageDraft;
  demagEnabled?: boolean;
  algorithmsAvailable?: readonly string[];
  index: number;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  requestedBackend?: string;
  requestedDevice?: string;
  requestedMode?: string;
  validation: readonly { message: string; severity: "error" | "warning" }[];
  view?: FrequencyDomainAuthoringView;
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
        <option value="add_field_drive">Add antenna</option>
        <option value="run">Run</option>
        <option value="hysteresis">Hysteresis</option>
        <option value="eigenmodes">Eigenmodes</option>
        <option value="frequency_response">Frequency response</option>
        <option value="save_state">Save state</option>
        <option value="change_device">Change device</option>
      </FormField>
      <FormField
        label="Stage ID"
        value={draft.stageId}
        onChange={(event) => onUpdate({ stageId: event.target.value })}
      />
      {draft.kind === "add_field_drive" ? (
        <div className="fm-study-stage-note">
          The ordered instruction adds its field drive to the current simulation
          state. Full antenna controls and the sampled source FFT are shown below.
        </div>
      ) : draft.kind === "run" ? (
        <FormField
          label="Until"
          unit="s"
          value={draft.untilSeconds}
          onChange={(event) => onUpdate({ untilSeconds: event.target.value })}
        />
      ) : draft.kind === "hysteresis" ? (
        <HysteresisStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : draft.kind === "eigenmodes" ? (
        <EigenmodesStageDraftFields
          draft={draft}
          onUpdate={onUpdate}
          view={view}
        />
      ) : draft.kind === "frequency_response" ? (
        <FrequencyResponseStageDraftFields
          draft={draft}
          onUpdate={onUpdate}
          view={view}
        />
      ) : draft.kind === "save_state" ? (
        <SaveStateStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : draft.kind === "change_device" ? (
        <ChangeDeviceStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : (
        <RelaxStageDraftFields
          algorithmsAvailable={algorithmsAvailable}
          draft={draft}
          demagEnabled={demagEnabled}
          onUpdate={onUpdate}
          requestedBackend={requestedBackend}
          requestedDevice={requestedDevice}
          requestedMode={requestedMode}
        />
      )}
    </div>
  );
}

function studyStageDraftKindLabel(kind: StudyStageDraftKind): string {
  if (kind === "add_field_drive") return "Add Antenna";
  if (kind === "eigenmodes") return "Eigenmodes";
  if (kind === "frequency_response") return "Frequency Response";
  if (kind === "hysteresis") return "Hysteresis";
  if (kind === "save_state") return "Save State";
  if (kind === "change_device") return "Change Device";
  if (kind === "run") return "Run";
  return "Relax";
}

function ChangeDeviceStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <FormField
      label="Device"
      type="select"
      value={draft.deviceTarget}
      onChange={(event) => onUpdate({ deviceTarget: event.target.value })}
    >
      <option value="cpu">CPU</option>
      <option value="gpu">GPU</option>
      <option value="cuda">CUDA</option>
      <option value="auto">Auto</option>
    </FormField>
  );
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
        <HysteresisFieldSegmentsEditor draft={draft} onUpdate={onUpdate} />
      ) : null}
      <HysteresisDenseWindowsEditor draft={draft} onUpdate={onUpdate} />
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
  return `settle-branch:${branch.branchId}:${branch.when}:${branch.run}`;
}

function hysteresisMinorLoopKey(loop: HysteresisMinorLoopDraft): string {
  return `minor-loop:${loop.reversalField}:${loop.returnField}:${loop.parentBranch}:${loop.closurePolicy}`;
}

function hysteresisFieldSegmentKey(
  segment: HysteresisFieldSegmentDraft,
): string {
  return `field-segment:${segment.segmentId}:${segment.label}:${segment.startField}:${segment.stopField}:${segment.step}`;
}

function hysteresisDenseWindowKey(
  window: HysteresisDenseWindowDraft,
): string {
  return `dense-window:${window.centerField}:${window.halfWidth}:${window.step}:${window.priority}:${window.reason}`;
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
        <strong>Settle tree branches</strong>
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
      <div className="fm-inspector-toolbar">
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
          Add branch
        </Button>
      </div>
      <FormField
        label="Settle branches JSON"
        rows={5}
        type="textarea"
        value={draft.settleBranches}
        onChange={(event) =>
          onUpdate({ settleBranches: event.target.value })
        }
      />
    </div>
  );
}

function HysteresisMinorLoopsEditor({
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
        <strong>Minor loop branches</strong>
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
          onClick={() =>
            commitLoops([
              ...loops,
              defaultHysteresisMinorLoop(loops.length, draft),
            ])
          }
        >
          Add minor loop
        </Button>
      </div>
      <FormField
        label="Minor loops JSON"
        rows={4}
        type="textarea"
        value={draft.minorLoops}
        onChange={(event) => onUpdate({ minorLoops: event.target.value })}
      />
    </div>
  );
}

function HysteresisFieldSegmentsEditor({
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
          <FormField
            label="Reason"
            value={segment.reason}
            onChange={(event) =>
              updateSegment(index, { reason: event.target.value })
            }
          />
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          onClick={() =>
            commitSegments([
              ...segments,
              defaultHysteresisFieldSegment(segments.length, draft),
            ])
          }
        >
          Add segment
        </Button>
      </div>
      <FormField
        label="Field segments JSON"
        rows={5}
        type="textarea"
        value={draft.fieldSegments}
        onChange={(event) => onUpdate({ fieldSegments: event.target.value })}
      />
    </div>
  );
}

function HysteresisDenseWindowsEditor({
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
          Add window
        </Button>
      </div>
      <FormField
        label="Dense windows JSON"
        rows={4}
        type="textarea"
        value={draft.denseWindows}
        onChange={(event) => onUpdate({ denseWindows: event.target.value })}
      />
    </div>
  );
}

export function HysteresisSettleAlgorithmsEditor({
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
    const steps = parsed.flatMap((step) =>
      isRecord(step) ? [normalizeHysteresisSettleStepPatch(step)] : [],
    );
    return steps.length > 0 ? steps : [DEFAULT_RELAX_SETTLE_STEP];
  } catch {
    return [DEFAULT_RELAX_SETTLE_STEP];
  }
}

function parseHysteresisFieldSegments(
  value: string,
): HysteresisFieldSegmentDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [defaultHysteresisFieldSegment(0)];
    let segmentIndex = 0;
    const segments = parsed.flatMap((segment) => {
      if (!isRecord(segment)) return [];
      const normalized = normalizeHysteresisFieldSegment(segment, segmentIndex);
      segmentIndex += 1;
      return [normalized];
    });
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
      index === 0 ? "include_stop" : "skip_start",
    ),
    label: stringFromUnknown(segment.label, `Segment ${index + 1}`),
    reason: stringFromUnknown(segment.reason, ""),
    segmentId: stringFromUnknown(
      segment.segmentId ?? segment.segment_id,
      `segment_${index + 1}`,
    ),
    startField: stringFromUnknown(
      segment.startField ?? segment.start_field ?? segment.start,
      "",
    ),
    step: stringFromUnknown(
      segment.step ?? segment.step_mT ?? segment.field_step_mT,
      "",
    ),
    stopField: stringFromUnknown(
      segment.stopField ?? segment.stop_field ?? segment.stop,
      "",
    ),
    unit: stringFromUnknown(segment.unit, "mT"),
  };
}

function defaultHysteresisFieldSegment(
  index: number,
  draft?: StudyStageDraft,
): HysteresisFieldSegmentDraft {
  return {
    endpointPolicy: index === 0 ? "include_stop" : "skip_start",
    label: index === 0 ? "Coarse start" : `Segment ${index + 1}`,
    reason: index === 0 ? "coarse_start" : "",
    segmentId: index === 0 ? "coarse_start" : `segment_${index + 1}`,
    startField: draft?.fieldMaxMt ?? "",
    step: draft?.fieldStepMt ?? "",
    stopField: draft?.fieldMinMt ?? "",
    unit: "mT",
  };
}

function parseHysteresisDenseWindows(
  value: string,
): HysteresisDenseWindowDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [defaultHysteresisDenseWindow(0)];
    let windowIndex = 0;
    const windows = parsed.flatMap((window) => {
      if (!isRecord(window)) return [];
      const normalized = normalizeHysteresisDenseWindow(window, windowIndex);
      windowIndex += 1;
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

function parseHysteresisMinorLoops(value: string): HysteresisMinorLoopDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [defaultHysteresisMinorLoop(0)];
    const loops = parsed.flatMap((loop) =>
      isRecord(loop) ? [normalizeHysteresisMinorLoop(loop)] : [],
    );
    return loops.length > 0 ? loops : [defaultHysteresisMinorLoop(0)];
  } catch {
    return [defaultHysteresisMinorLoop(0)];
  }
}

function parseHysteresisSettleBranches(
  value: string,
): HysteresisSettleBranchDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
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
  algorithmsAvailable,
  draft,
  demagEnabled,
  onUpdate,
  requestedBackend,
  requestedDevice,
  requestedMode,
}: {
  draft: StudyStageDraft;
  demagEnabled: boolean;
  algorithmsAvailable?: readonly string[];
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  requestedBackend: string;
  requestedDevice: string;
  requestedMode: string;
}) {
  const tpiEligible =
    requestedMode === "extended" &&
    requestedBackend === "fem" &&
    requestedDevice === "cpu";
  const availability = (value: string) =>
    relaxationAlgorithmAvailability(value, {
      algorithmsAvailable,
      backend: requestedBackend,
      demagEnabled,
      device: requestedDevice,
      mode: requestedMode,
    });
  const algorithmSupported = (value: string) => availability(value).supported;
  return (
    <>
      <FormField
        label="Algorithm"
        type="select"
        value={draft.algorithm}
        onChange={(event) => {
          const algorithm = event.target.value;
          onUpdate(
            algorithm === "llg_overdamped"
              ? { algorithm }
              : {
                  algorithm,
                  demagInterval: "",
                  dt: "",
                  dtMin: "",
                  fieldEvery: "",
                  maxError: "",
                  maxRelaxationTime: "",
                  relaxAlpha: "",
                  solver: "",
                },
          );
        }}
      >
        <option value="llg_overdamped" disabled={!algorithmSupported("llg_overdamped")}>
          LLG overdamped{algorithmSupported("llg_overdamped") ? "" : " (not advertised by active session)"}
        </option>
        <option value="projected_gradient_bb" disabled={!algorithmSupported("projected_gradient_bb")}>
          Projected gradient BB
          {algorithmSupported("projected_gradient_bb")
            ? ""
            : ` — ${availability("projected_gradient_bb").reason}`}
        </option>
        <option value="nonlinear_cg" disabled={!algorithmSupported("nonlinear_cg")}>
          Nonlinear CG{algorithmSupported("nonlinear_cg") ? "" : " (not advertised by active session)"}
        </option>
        {tpiEligible || draft.algorithm === "tangent_plane_implicit" ? (
          <option
            value="tangent_plane_implicit"
            disabled={
              !tpiEligible || !algorithmSupported("tangent_plane_implicit")
            }
          >
            Tangent-plane implicit (development CPU only)
            {algorithmSupported("tangent_plane_implicit")
              ? ""
              : ` — ${availability("tangent_plane_implicit").reason}`}
          </option>
        ) : null}
      </FormField>
      <FormField
        label="Torque tol"
        unit="A/m"
        hint="Canonical max |m × H_eff| threshold; tesla is a derived display conversion."
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
      {draft.algorithm === "llg_overdamped" ? (
        <>
          <FormField
            label="Max relaxation time"
            unit="s"
            value={draft.maxRelaxationTime}
            onChange={(event) => onUpdate({ maxRelaxationTime: event.target.value })}
          />
          <FormField
            label="Relax alpha"
            value={draft.relaxAlpha}
            onChange={(event) => onUpdate({ relaxAlpha: event.target.value })}
          />
          <FormField
            label="Integrator"
            hint="Per-integrator capability reasons are not published; the active-session planner validates this choice."
            type="select"
            value={draft.solver}
            onChange={(event) => onUpdate({ solver: event.target.value })}
          >
            <option value="">Default</option>
            <option value="rk23">RK23</option>
            <option value="rk45">RK45</option>
            <option value="heun">Heun</option>
          </FormField>
          <FormField
            label="Timestep mode"
            type="select"
            value={draft.timestepMode}
            onChange={(event) =>
              onUpdate(
                event.target.value === "fixed"
                  ? {
                      dt: "",
                      dtMin: "",
                      maxError: "",
                      timestepConflict: false,
                      timestepMode: "fixed",
                    }
                  : event.target.value === "adaptive"
                    ? {
                        dt: "",
                        timestepConflict: false,
                        timestepMode: "adaptive",
                      }
                    : {
                        dt: "",
                        dtMin: "",
                        maxError: "",
                        timestepConflict: false,
                        timestepMode: "auto",
                      },
              )
            }
          >
            <option value="auto">Auto</option>
            <option value="fixed">Fixed</option>
            <option value="adaptive">Adaptive</option>
          </FormField>
          {draft.timestepMode === "fixed" ? (
            <FormField
              label="Fixed dt"
              unit="s"
              value={draft.dt}
              onChange={(event) => onUpdate({ dt: event.target.value })}
            />
          ) : draft.timestepMode === "adaptive" ? (
            <>
              <FormField
                label="Initial dt"
                unit="s"
                value={draft.dt}
                onChange={(event) => onUpdate({ dt: event.target.value })}
              />
              <FormField
                label="Adaptive dt min"
                unit="s"
                value={draft.dtMin}
                onChange={(event) => onUpdate({ dtMin: event.target.value })}
              />
              <FormField
                label="Adaptive tolerance"
                value={draft.maxError}
                onChange={(event) => onUpdate({ maxError: event.target.value })}
              />
            </>
          ) : null}
          <FormField
            label="Demag interval"
            unit="s"
            value={draft.demagInterval}
            onChange={(event) => onUpdate({ demagInterval: event.target.value })}
          />
          <FormField
            label="Field every"
            hint="Push field samples every N solver steps."
            value={draft.fieldEvery}
            onChange={(event) => onUpdate({ fieldEvery: event.target.value })}
          />
        </>
      ) : null}
    </>
  );
}

function EigenmodesStageDraftFields({
  draft,
  onUpdate,
  view,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  view: FrequencyDomainAuthoringView;
}) {
  if (view === "calculation_mode") {
    return <CalculationModeDraftField draft={draft} onUpdate={onUpdate} />;
  }
  if (view === "solver" || view === "outputs") {
    return (
      <>
        {view === "solver" ? (
          <SpectralStageDraftFields
            draft={draft}
            onUpdate={onUpdate}
            view="solver"
          />
        ) : null}
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
          <option value="nearest">Nearest</option>
          <option value="frequency_window">Frequency window</option>
          <option value="largest">Largest</option>
          <option value="near_frequency">Near frequency</option>
        </FormField>
        {draft.target === "frequency_window" ? (
          <>
            <FormField
              label="Frequency min"
              hint={frequencyDraftPreview(draft.frequencyMin)}
              unit="Hz"
              value={draft.frequencyMin}
              onChange={(event) => onUpdate({ frequencyMin: event.target.value })}
            />
            <FormField
              label="Frequency max"
              hint={frequencyDraftPreview(draft.frequencyMax)}
              unit="Hz"
              value={draft.frequencyMax}
              onChange={(event) => onUpdate({ frequencyMax: event.target.value })}
            />
          </>
        ) : (
          <FormField
            label="Target freq"
            hint={frequencyDraftPreview(draft.targetFrequency)}
            unit="Hz"
            value={draft.targetFrequency}
            onChange={(event) =>
              onUpdate({ targetFrequency: event.target.value })
            }
          />
        )}
      </>
    );
  }
  if (view !== "overview") {
    return (
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view={view}
      />
    );
  }
  return (
    <>
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view="overview"
      />
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
        <option value="nearest">Nearest</option>
        <option value="frequency_window">Frequency window</option>
        <option value="largest">Largest</option>
        <option value="near_frequency">Near frequency</option>
      </FormField>
      {draft.target === "frequency_window" ? (
        <>
          <FormField
            label="Frequency min"
            hint={frequencyDraftPreview(draft.frequencyMin)}
            unit="Hz"
            value={draft.frequencyMin}
            onChange={(event) => onUpdate({ frequencyMin: event.target.value })}
          />
          <FormField
            label="Frequency max"
            hint={frequencyDraftPreview(draft.frequencyMax)}
            unit="Hz"
            value={draft.frequencyMax}
            onChange={(event) => onUpdate({ frequencyMax: event.target.value })}
          />
        </>
      ) : (
        <FormField
          label="Target freq"
          hint={frequencyDraftPreview(draft.targetFrequency)}
          unit="Hz"
          value={draft.targetFrequency}
          onChange={(event) => onUpdate({ targetFrequency: event.target.value })}
        />
      )}
    </>
  );
}

function FrequencyResponseStageDraftFields({
  draft,
  onUpdate,
  view,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  view: FrequencyDomainAuthoringView;
}) {
  if (view === "calculation_mode") {
    return <CalculationModeDraftField draft={draft} onUpdate={onUpdate} />;
  }
  if (view === "excitation") {
    return (
      <>
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
          onChange={(event) =>
            onUpdate({ excitationPhaseRad: event.target.value })
          }
        />
      </>
    );
  }
  if (view === "sweep") {
    return (
      <FormField
        label="Frequencies"
        hint={frequencyListDraftPreview(draft.frequenciesHz)}
        value={draft.frequenciesHz}
        onChange={(event) => onUpdate({ frequenciesHz: event.target.value })}
      />
    );
  }
  if (view === "outputs") {
    return (
      <FormField
        label="Observable"
        value={draft.observable}
        onChange={(event) => onUpdate({ observable: event.target.value })}
      />
    );
  }
  if (view !== "overview") {
    return (
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view={view}
      />
    );
  }
  return (
    <>
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view="overview"
      />
      <FormField
        label="Frequencies"
        hint={frequencyListDraftPreview(draft.frequenciesHz)}
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

function frequencyDraftPreview(value: string | null | undefined): string {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "Stored as Hz; preview not available";
  }
  return `Stored as Hz; preview ${formatFrequencyHz(parsed)}`;
}

function frequencyListDraftPreview(value: string | null | undefined): string {
  const frequencies = parseNumberList(value).filter(
    (entry) => Number.isFinite(entry) && entry > 0,
  );
  if (!frequencies.length) {
    return "Comma or whitespace separated values in Hz.";
  }
  return `Stored as Hz; preview ${frequencies
    .map((entry) => formatFrequencyHz(entry))
    .join(", ")}`;
}

function parseNumberList(value: string | null | undefined): number[] {
  return String(value ?? "")
    .split(/[\s,;]+/)
    .flatMap((entry) => {
      const parsed = Number(entry.trim());
      return Number.isFinite(parsed) ? [parsed] : [];
    });
}

function CalculationModeDraftField({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const options =
    draft.kind === "frequency_response"
      ? [
          ["fmr_response", "FMR response"],
          ["response_map", "Response map"],
        ]
      : [
          ["fmr_modal", "FMR modal"],
          ["free_modes", "Free modes"],
          ["dispersion_modal", "Dispersion modal"],
        ];
  return (
    <FormField
      label="Calculation mode"
      type="select"
      value={draft.calculationMode}
      onChange={(event) => onUpdate({ calculationMode: event.target.value })}
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </FormField>
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
  view,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  view: FrequencyDomainAuthoringView;
}) {
  const showEquilibrium = view === "overview" || view === "equilibrium";
  const showOperator =
    view === "overview" || view === "operator" || view === "solver";
  const showBoundary =
    view === "overview" || view === "boundary" || view === "periodic_pairs";
  const showKSampling =
    view === "overview" ||
    view === "k_sampling" ||
    view === "k_path" ||
    view === "k_grid";
  return (
    <>
      {showOperator ? (
        <>
          {draft.kind === "eigenmodes" ? (
            <FormField
              label="Operator"
              type="select"
              value={draft.operator}
              onChange={(event) => onUpdate({ operator: event.target.value })}
            >
              <option value="linearized_llg">Linearized LLG</option>
              <option value="full_2x2">Full 2x2</option>
            </FormField>
          ) : null}
          {draft.kind === "frequency_response" ? (
            <FormField
              label="Solver method"
              type="select"
              value={draft.solverMethod}
              onChange={(event) =>
                onUpdate({ solverMethod: event.target.value })
              }
            >
              <option value="auto">Auto</option>
              <option value="dense_reference">Dense reference</option>
              <option value="cpu_sparse_direct">CPU sparse direct</option>
              <option value="full_coupled_field_split">
                Full coupled field split
              </option>
              <option value="schur_reduced">Schur reduced</option>
              <option value="modal_reduced">Modal reduced</option>
              <option value="gpu_operator_host_krylov">
                GPU operator host Krylov
              </option>
              <option value="gpu_device_krylov">GPU device Krylov</option>
            </FormField>
          ) : null}
          <FormField
            label="Include demag"
            checked={draft.includeDemag}
            type="checkbox"
            onChange={(event) =>
              onUpdate({ includeDemag: event.target.checked })
            }
          />
          <FormField
            label="Normalization"
            type="select"
            value={draft.normalization}
            onChange={(event) =>
              onUpdate({ normalization: event.target.value })
            }
          >
            <option value="unit_l2">Unit L2</option>
            <option value="unit_max_amplitude">Unit max amplitude</option>
          </FormField>
          <FormField
            label="Damping"
            type="select"
            value={draft.dampingPolicy}
            onChange={(event) =>
              onUpdate({ dampingPolicy: event.target.value })
            }
          >
            <option value="ignore">Ignore</option>
            <option value="include">Include</option>
          </FormField>
        </>
      ) : null}
      {showEquilibrium ? (
        <>
          <FormField
            label="Equilibrium"
            type="select"
            value={draft.equilibriumSource}
            onChange={(event) =>
              onUpdate({ equilibriumSource: event.target.value })
            }
          >
            <option value="relax">Relax stage</option>
            <option value="provided">Provided state</option>
            <option value="artifact">Named artifact</option>
          </FormField>
          <FormField
            label="Eq artifact"
            value={draft.equilibriumArtifact}
            onChange={(event) =>
              onUpdate({ equilibriumArtifact: event.target.value })
            }
          />
        </>
      ) : null}
      {showKSampling ? (
        <>
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
          {draft.kind === "eigenmodes" ? (
            <FormField
              label="k path"
              hint="Label:kx,ky,kz; Label:kx,ky,kz | samples=n,n"
              type="textarea"
              rows={3}
              value={draft.kPath}
              onChange={(event) => onUpdate({ kPath: event.target.value })}
            />
          ) : null}
        </>
      ) : null}
      {showBoundary ? (
        <>
          <FormField
            label="BC"
            hint="Boundary condition name or JSON object."
            value={draft.bc}
            onChange={(event) => onUpdate({ bc: event.target.value })}
          />
          {draft.kind === "frequency_response" ? (
            <FormField
              label="Magnetostatic BC"
              type="select"
              value={draft.magnetostaticBc}
              onChange={(event) =>
                onUpdate({ magnetostaticBc: event.target.value })
              }
            >
              <option value="open">Open</option>
              <option value="periodic_airbox_k0">Periodic airbox k=0</option>
              <option value="floquet_airbox">Floquet airbox</option>
            </FormField>
          ) : null}
        </>
      ) : null}
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
