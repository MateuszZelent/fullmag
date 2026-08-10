import {
  Activity,
  Plus,
  Radio,
  Sigma,
  Save,
  Gauge,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";

import {
  validateStudyStageDraft,
  type K0ModalExecutionReadiness,
  type StudyStageDraft,
} from "./StudyStageAuthoringModel";
import type {
  StudyAdaptiveTimestepDraft,
  StudySolverDraft,
} from "./StudyGlobalAuthoringModel";
import type {
  StudyInspectorModel,
} from "./StudyInspectorPanelModel";
import { validateStudyWorkflow } from "./stages/studyWorkflowState";
import { StageCard } from "./StudyStageCard";
import { StudyStageDraftEditor } from "./StudyStageDraftEditor";

export { StageCard, StudyStageDraftEditor };

type StudyCommandRunner = (commandId: string, input?: unknown) => void;
type StudyCommandDisabledReason = (commandId: string) => string | null;
const EMPTY_ALGORITHMS: readonly string[] = [];

export function StudySolverPolicyFields({
  algorithmsAvailable,
  draft,
  onUpdate,
  requestedBackend = "auto",
  requestedDevice = "auto",
  requestedPrecision = "double",
}: {
  algorithmsAvailable?: readonly string[];
  draft: StudySolverDraft;
  onUpdate: (patch: Partial<StudySolverDraft>) => void;
  requestedBackend?: string;
  requestedDevice?: string;
  requestedPrecision?: string;
}) {
  const supportsAdaptive =
    (algorithmsAvailable?.includes("llg_overdamped") ?? false) &&
    requestedPrecision === "double" &&
    (requestedBackend === "fem" || requestedDevice === "cpu");
  const updateAdvanced = (patch: Partial<StudyAdaptiveTimestepDraft>) =>
    onUpdate({
      adaptiveTimestep: {
        atol: "",
        dtInitial: "",
        dtMax: "",
        dtMin: "",
        growthLimit: "2",
        maxSpinRotation: "",
        normTolerance: "",
        rtol: "",
        safety: "0.9",
        shrinkLimit: "0.2",
        ...draft.adaptiveTimestep,
        ...patch,
      },
    });
  return (
    <>
      <FormField
        label="Integrator"
        type="select"
        value={draft.integrator}
        onChange={(event) => onUpdate({ integrator: event.target.value })}
      >
        <option value="">Default</option>
        <option value="heun">Heun</option>
        <option value="rk23">RK23</option>
        <option value="rk45">RK45</option>
      </FormField>
      <FormField
        label="Timestep policy"
        hint={supportsAdaptive ? "LLG is advertised by the active session; the planner validates the requested RK lane." : "LLG is not advertised by the active session."}
        type="select"
        value={draft.timestepMode}
        onChange={(event) =>
          onUpdate({
            timestepMode: event.target.value as StudySolverDraft["timestepMode"],
          })
        }
      >
        <option value="auto">Unspecified</option>
        <option value="fixed">Fixed</option>
        <option value="adaptive_max_error" disabled={!supportsAdaptive}>Adaptive — maximum vector error</option>
        <option value="adaptive_advanced" disabled={!supportsAdaptive}>Adaptive — advanced atol/rtol</option>
      </FormField>
      {draft.timestepMode === "fixed" ? (
        <FormField label="Fixed dt" unit="s" value={draft.fixDt} onChange={(event) => onUpdate({ fixDt: event.target.value })} />
      ) : draft.timestepMode === "adaptive_max_error" ? (
        <>
          <FormField label="Initial dt" hint="Optional; omission resolves exactly to dt min." unit="s" value={draft.dtInitial} onChange={(event) => onUpdate({ dtInitial: event.target.value })} />
          <FormField label="Adaptive dt min" unit="s" value={draft.dtMin} onChange={(event) => onUpdate({ dtMin: event.target.value })} />
          <FormField label="Adaptive dt max" unit="s" value={draft.dtMax} onChange={(event) => onUpdate({ dtMax: event.target.value })} />
          <FormField label="Maximum embedded vector error" hint="Absolute maximum node/cell embedded-vector error." value={draft.maxErr} onChange={(event) => onUpdate({ maxErr: event.target.value })} />
        </>
      ) : draft.timestepMode === "adaptive_advanced" ? (
        <>
          <FormField label="Absolute tolerance" value={draft.adaptiveTimestep?.atol ?? ""} onChange={(event) => updateAdvanced({ atol: event.target.value })} />
          <FormField label="Relative tolerance" value={draft.adaptiveTimestep?.rtol ?? ""} onChange={(event) => updateAdvanced({ rtol: event.target.value })} />
          <FormField label="Initial dt" hint="Optional; omission resolves exactly to dt min." unit="s" value={draft.adaptiveTimestep?.dtInitial ?? ""} onChange={(event) => updateAdvanced({ dtInitial: event.target.value })} />
          <FormField label="Adaptive dt min" unit="s" value={draft.adaptiveTimestep?.dtMin ?? ""} onChange={(event) => updateAdvanced({ dtMin: event.target.value })} />
          <FormField label="Adaptive dt max" unit="s" value={draft.adaptiveTimestep?.dtMax ?? ""} onChange={(event) => updateAdvanced({ dtMax: event.target.value })} />
          <FormField label="Safety factor" value={draft.adaptiveTimestep?.safety ?? "0.9"} onChange={(event) => updateAdvanced({ safety: event.target.value })} />
          <FormField label="Growth limit" value={draft.adaptiveTimestep?.growthLimit ?? "2"} onChange={(event) => updateAdvanced({ growthLimit: event.target.value })} />
          <FormField label="Shrink limit" value={draft.adaptiveTimestep?.shrinkLimit ?? "0.2"} onChange={(event) => updateAdvanced({ shrinkLimit: event.target.value })} />
          <FormField label="Max spin rotation" value={draft.adaptiveTimestep?.maxSpinRotation ?? ""} onChange={(event) => updateAdvanced({ maxSpinRotation: event.target.value })} />
          <FormField label="Norm tolerance" value={draft.adaptiveTimestep?.normTolerance ?? ""} onChange={(event) => updateAdvanced({ normTolerance: event.target.value })} />
        </>
      ) : null}
      <FormField label="Demag interval" unit="s" value={draft.demagInterval} onChange={(event) => onUpdate({ demagInterval: event.target.value })} />
    </>
  );
}

export function StudyPipelineSection({
  activeStageIndex,
  activeLane,
  algorithmsAvailable = EMPTY_ALGORITHMS,
  authoringBusy = false,
  authoringFeedback,
  demagEnabled = false,
  k0ModalReadinessFor,
  draft,
  draftIndex,
  drafts,
  model,
  showDraftEditor = true,
  onAddStage,
  onCommit,
  onDuplicateStage,
  onMoveStage,
  onRemoveStage,
  onSelectDraft,
  onUpdateDraft,
  runCommand,
  commandDisabledReason,
}: {
  activeStageIndex: number | null;
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  authoringBusy?: boolean;
  authoringFeedback: { kind: "success" | "danger" | "error" | "warning"; message: string } | null;
  demagEnabled?: boolean;
  k0ModalReadinessFor?: (draft: StudyStageDraft) => K0ModalExecutionReadiness;
  draft: StudyStageDraft | null;
  draftIndex: number;
  drafts: readonly StudyStageDraft[];
  model: StudyInspectorModel;
  showDraftEditor?: boolean;
  onAddStage: (kind: StudyStageDraft["kind"]) => void;
  onCommit?: () => void;
  onDuplicateStage?: (index: number) => void;
  onMoveStage?: (index: number, direction: -1 | 1) => void;
  onRemoveStage?: (index: number) => void;
  onSelectDraft: (index: number) => void;
  onUpdateDraft: (index: number, patch: Partial<StudyStageDraft>) => void;
  runCommand: StudyCommandRunner;
  commandDisabledReason: StudyCommandDisabledReason;
}) {
  const localValidation = draft
    ? validateStudyStageDraft(draft, {
        activeLane,
        algorithmsAvailable,
        backend: model.requested.backend,
        demagEnabled,
        device: model.requested.device,
        ...k0ModalReadinessFor?.(draft),
        mode: model.requested.mode,
        precision: model.requested.precision,
      })
    : [];
  const validation = [
    ...localValidation,
    ...validateStudyWorkflow(drafts).flatMap((issue) =>
      issue.index === draftIndex
        ? [{ message: issue.message, severity: issue.severity }]
        : [],
    ),
  ];
  const hasDraftErrors = validation.some((issue) => issue.severity === "error");
  return (
    <InspectorGroup
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
        <>
          <StudyStageDraftEditor
            draft={draft}
            demagEnabled={demagEnabled}
            algorithmsAvailable={algorithmsAvailable}
            index={draftIndex}
            requestedBackend={model.requested.backend}
            requestedDevice={model.requested.device}
            requestedMode={model.requested.mode}
            requestedPrecision={model.requested.precision}
            validation={validation}
            onUpdate={(patch) => onUpdateDraft(draftIndex, patch)}
          />
          <div className="fm-inspector-toolbar">
            {onDuplicateStage ? (
              <Button disabled={authoringBusy} size="sm" type="button" variant="ghost" onClick={() => onDuplicateStage(draftIndex)}>
                Duplicate
              </Button>
            ) : null}
            {onMoveStage ? (
              <>
                <Button aria-label="Move stage up" disabled={authoringBusy || draftIndex <= 0} size="sm" type="button" variant="ghost" onClick={() => onMoveStage(draftIndex, -1)}>
                  Move up
                </Button>
                <Button aria-label="Move stage down" disabled={authoringBusy || draftIndex >= drafts.length - 1} size="sm" type="button" variant="ghost" onClick={() => onMoveStage(draftIndex, 1)}>
                  Move down
                </Button>
              </>
            ) : null}
            {onRemoveStage ? (
              <Button disabled={authoringBusy} size="sm" type="button" variant="danger" onClick={() => onRemoveStage(draftIndex)}>
                Remove
              </Button>
            ) : null}
            <span className="fm-inspector-toolbar__spacer" />
            {onCommit ? (
              <Button
                disabled={authoringBusy || hasDraftErrors}
                size="sm"
                title={
                  hasDraftErrors
                    ? "Fix stage validation errors before saving."
                    : authoringBusy
                      ? "Saving stages."
                      : "Save stages"
                }
                type="button"
                variant="primary"
                onClick={onCommit}
              >
                {authoringBusy ? "Saving…" : "Save stages"}
              </Button>
            ) : null}
          </div>
        </>
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
          kind={authoringFeedback.kind === "danger" ? "error" : authoringFeedback.kind}
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
          onClick={() => onAddStage("table_autosave")}
        >
          <Activity size={13} aria-hidden="true" />
          Autosave Clock
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("autosave")}
        >
          <Save size={13} aria-hidden="true" />
          Periodic output
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("fft_response")}
        >
          <Sigma size={13} aria-hidden="true" />
          Response FFT
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("run")}
        >
          <Plus size={13} aria-hidden="true" />
          Run
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("hysteresis")}
        >
          <Plus size={13} aria-hidden="true" />
          Hysteresis loop
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("eigenmodes")}
        >
          <Plus size={13} aria-hidden="true" />
          Modal eigenmodes
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("frequency_response")}
        >
          <Plus size={13} aria-hidden="true" />
          Frequency response
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("change_device")}
        >
          <Plus size={13} aria-hidden="true" />
          Change device
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onAddStage("save_state")}
        >
          <Plus size={13} aria-hidden="true" />
          Save state
        </Button>
      </div>

      <div className="fm-inspector-toolbar fm-mt-2">
        <PipelineCommandButton
          commandId="study.compute-observables"
          disabledReason={commandDisabledReason("study.compute-observables")}
          icon={<Gauge size={13} />}
          label="Observables"
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
    </InspectorGroup>
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
