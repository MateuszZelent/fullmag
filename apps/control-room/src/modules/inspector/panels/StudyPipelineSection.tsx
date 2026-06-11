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
      </FormField>
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
        label="Torque tol"
        value={draft.torqueTolerance}
        onChange={(event) => onUpdate({ torqueTolerance: event.target.value })}
      />
    </>
  );
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
