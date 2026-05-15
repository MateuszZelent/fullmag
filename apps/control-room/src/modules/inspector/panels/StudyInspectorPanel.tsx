"use client";

import {
  Activity,
  Download,
  Info,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Sigma,
  SkipForward,
  Square,
  Upload,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "@/kernel/api/apiPaths";
import type {
  CheckpointEntry,
  SessionImportInspectResponse,
} from "@/kernel/api/apiTypes";
import {
  useCommandQueueResource,
  useCommandDetailResource,
  useCheckpointCatalogResource,
  useCurrentRunResource,
  useSolverEnergyCurrentResource,
  useSolverEnergyHistoryResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useKernel } from "@/kernel/KernelContext";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatus,
} from "@/kernel/resources/useSessionStatus";
import { Accordion } from "@/shared/ui/Accordion";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

import {
  resolveStudyInspectorModel,
  studySnapshotFromScene,
  type StudyStageModel,
} from "./StudyInspectorPanelModel";

export { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";

function ProgressBar({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const pct = value ?? 0;
  return (
    <div
      className="fm-study-progress"
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value ?? undefined}
      role="progressbar"
    >
      <span className="fm-study-progress__bar" style={{ width: `${pct}%` }} />
      <span className="fm-study-progress__label">
        {value == null ? "pending" : `${pct}%`}
      </span>
    </div>
  );
}

function StageCard({
  active,
  stage,
}: {
  active: boolean;
  stage: StudyStageModel;
}) {
  return (
    <div
      className="fm-study-stage-card"
      data-active={active ? "true" : undefined}
      data-status={stage.status}
    >
      <div className="fm-study-stage-card__header">
        <span>{stage.label}</span>
        <small>{stage.status}</small>
      </div>
      <ProgressBar
        label={`${stage.label} progress`}
        value={stage.progressPercent}
      />
      <div className="fm-study-stage-card__meta">
        {stage.torqueTolerance ? <span>tau {stage.torqueTolerance}</span> : null}
        {stage.energyTolerance ? <span>E {stage.energyTolerance}</span> : null}
        {stage.maxSteps ? <span>{stage.maxSteps} steps</span> : null}
        {stage.untilSeconds ? <span>{stage.untilSeconds} s</span> : null}
      </div>
    </div>
  );
}

export function StudyInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importFmsBase64, setImportFmsBase64] = useState<string | null>(null);
  const [importInspection, setImportInspection] = useState<
    SessionImportInspectResponse["inspection"] | null
  >(null);
  const [importInspecting, setImportInspecting] = useState(false);
  const [importRestoreMode, setImportRestoreMode] = useState("resume");
  const [selectedRestoreCheckpointId, setSelectedRestoreCheckpointId] =
    useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(
    null,
  );
  const scene = useSceneResource();
  const currentRun = useCurrentRunResource();
  const stageExecution = useStageExecutionResource();
  const solverStatus = useSolverStatusResource();
  const commandQueue = useCommandQueueResource();
  const checkpointCatalog = useCheckpointCatalogResource();
  const geometryValidation = useGeometryValidationResource();
  const meshBuildCurrent = useMeshBuildCurrent();
  const meshBuildLatest = useMeshBuildLatestSuccessful();
  const meshManifest = useMeshSharedDomainManifestResource();
  const meshSummary = useMeshSummaryResource();
  const sessionStatus = useSessionStatus();
  const energyCurrent = useSolverEnergyCurrentResource();
  const energyHistory = useSolverEnergyHistoryResource(120);
  const commandDetail = useCommandDetailResource(selectedCommandId);
  const checkpoints = checkpointCatalog.data?.checkpoints ?? [];
  const latestCheckpoint = checkpoints[0] ?? null;
  const selectedRestoreCheckpoint =
    checkpoints.find(
      (checkpoint) => checkpoint.checkpoint_id === selectedRestoreCheckpointId,
    ) ??
    latestCheckpoint ??
    null;
  const snapshot = studySnapshotFromScene(scene.data);
  const model = resolveStudyInspectorModel({
    commandQueue: commandQueue.data,
    currentRun: currentRun.data,
    selectedNodeId: selection.nodeId,
    snapshot,
    solverStatus: solverStatus.data,
    stageExecution: stageExecution.data,
  });
  const activeStageIndex = stageExecution.data?.active_stage_index ?? null;
  const commandContext = createCommandContext("ribbon", kernel, {
    resourceData: {
      [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
      [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
      [MESHING_SUMMARY_PATH]: meshSummary.data,
      [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
      [MODEL_SCENE_PATH]: scene.data,
      [PERSISTENCE_CHECKPOINTS_PATH]: checkpointCatalog.data,
      [SESSION_STATUS_RESOURCE_KEY]: sessionStatus.data,
      [SIMULATION_COMMANDS_PATH]: commandQueue.data,
      [SIMULATION_RUN_CURRENT_PATH]: currentRun.data,
      [SIMULATION_SOLVER_STATUS_PATH]: solverStatus.data,
      [SIMULATION_STAGES_EXECUTION_PATH]: stageExecution.data,
    },
  });
  const runCommand = (commandId: string, input?: unknown) => {
    void kernel.commands.execute(commandId, commandContext, input);
  };
  const inspectImportFile = async (file: File | null) => {
    setImportError(null);
    setImportInspection(null);
    setImportFmsBase64(null);
    setImportFileName(file?.name ?? null);
    if (!file) return;

    setImportInspecting(true);
    try {
      const fmsBase64 = await readFileAsBase64(file);
      const inspection = await kernel.api.persistence.imports.inspect({
        fms_base64: fmsBase64,
      });
      setImportFmsBase64(fmsBase64);
      setImportInspection(inspection.inspection);
      setImportRestoreMode(inspection.inspection.restore_class ?? "resume");
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Failed to inspect .fms file.",
      );
    } finally {
      setImportInspecting(false);
    }
  };
  const commandEnabled = (commandId: string) =>
    kernel.commands.isEnabled(commandId, commandContext);
  const commandDisabledReason = (commandId: string) =>
    commandEnabled(commandId)
      ? null
      : kernel.commands.get(commandId)?.disabledReason?.(commandContext) ??
        "Command is unavailable.";

  return (
    <>
      <Accordion
        className="fm-inspector-panel"
        type="multiple"
        defaultValue={[
          "runtime",
          "selected-stage",
          "boundary",
          "pipeline",
          "recovery",
          "history",
        ]}
      >
        <InspectorSection
          value="runtime"
          title="Runtime"
          badge={model.runtime.state}
        >
          <FieldRow label="Run" value={model.runtime.runId} />
          <FieldRow
            label="Active stage"
            value={model.runtime.activeStageLabel}
          />
          <FieldRow
            label="Command"
            value={
              model.runtime.commandId ? (
                <button
                  type="button"
                  className="fm-study-command-link"
                  onClick={() => setSelectedCommandId(model.runtime.commandId)}
                  title="Open command detail"
                >
                  <span>{model.runtime.commandLabel}</span>
                  <Info size={12} aria-hidden="true" />
                </button>
              ) : (
                model.runtime.commandLabel
              )
            }
          />
          {model.runtime.commandError ? (
            <FieldRow label="Command error" value={model.runtime.commandError} />
          ) : null}
          <FieldRow label="Max torque" value={model.runtime.maxTorque} />
          <FieldRow
            label="Step"
            value={
              solverStatus.data?.step_index ??
              currentRun.data?.total_steps ??
              "n/a"
            }
          />
          <ProgressBar
            label="Current study progress"
            value={model.runtime.progressPercent}
          />
          <div className="fm-inspector-toolbar">
            <StudyCommandButton
              commandId="study.run"
              disabledReason={commandDisabledReason("study.run")}
              icon={<Play size={13} />}
              label="Compute"
              onRun={runCommand}
            />
            <StudyCommandButton
              commandId="study.pause"
              disabledReason={commandDisabledReason("study.pause")}
              icon={<Pause size={13} />}
              label="Pause"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.resume"
              disabledReason={commandDisabledReason("study.resume")}
              icon={<Play size={13} />}
              label="Resume"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.skip"
              disabledReason={commandDisabledReason("study.skip")}
              icon={<SkipForward size={13} />}
              label="Skip"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.stop"
              disabledReason={commandDisabledReason("study.stop")}
              icon={<Square size={13} />}
              label="Stop"
              onRun={runCommand}
              variant="danger"
            />
          </div>
        </InspectorSection>

        <InspectorSection
          value="selected-stage"
          title="Selected Stage"
          badge={model.selectedStage?.status ?? "none"}
        >
          <FieldRow label="Kind" value={model.selectedStage?.kind ?? "none"} />
          <FieldRow
            label="Torque stop"
            value={model.selectedStage?.torqueTolerance ?? "not set"}
          />
          <FieldRow
            label="Energy stop"
            value={model.selectedStage?.energyTolerance ?? "not set"}
          />
          <FieldRow
            label="Step budget"
            value={model.selectedStage?.maxSteps ?? "not set"}
          />
          <FieldRow
            label="Time budget"
            value={model.selectedStage?.untilSeconds ?? "not set"}
            unit={model.selectedStage?.untilSeconds ? "s" : undefined}
          />
          <ProgressBar
            label="Selected stage progress"
            value={model.selectedStage?.progressPercent ?? null}
          />
        </InspectorSection>

        <InspectorSection
          value="boundary"
          title="Boundary Conditions"
          badge={snapshot.requested.backend}
        >
          <FieldRow
            label="Demag realization"
            value={model.boundary.demagRealization}
          />
          <FieldRow
            label="External field"
            value={model.boundary.externalField}
          />
          <FieldRow label="Device" value={snapshot.requested.device} />
          <FieldRow label="Precision" value={snapshot.requested.precision} />
          <FieldRow label="Mode" value={snapshot.requested.mode} />
        </InspectorSection>

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
                stage={stage}
              />
            ))}
          </div>
          <div className="fm-inspector-toolbar">
            <StudyCommandButton
              commandId="study.add-relax-stage"
              disabledReason={commandDisabledReason("study.add-relax-stage")}
              icon={<Plus size={13} />}
              label="Relax"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.add-run-stage"
              disabledReason={commandDisabledReason("study.add-run-stage")}
              icon={<Zap size={13} />}
              label="Run"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.compute-fields"
              disabledReason={commandDisabledReason("study.compute-fields")}
              icon={<Activity size={13} />}
              label="Fields"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.compute-energies"
              disabledReason={commandDisabledReason("study.compute-energies")}
              icon={<Sigma size={13} />}
              label="Energies"
              onRun={runCommand}
              variant="ghost"
            />
          </div>
        </InspectorSection>

        <InspectorSection
          value="recovery"
          title="Recovery"
          badge={`${checkpointCatalog.data?.checkpoints.length ?? 0}`}
        >
          <FieldRow
            label="Latest checkpoint"
            value={latestCheckpoint?.checkpoint_id ?? "not available"}
          />
          <FieldRow
            label="Resume class"
            value={latestCheckpoint?.resume_class ?? "not available"}
          />
          <FieldRow
            label="Checkpoint step"
            value={latestCheckpoint?.step ?? "not available"}
          />
          <div className="fm-inspector-toolbar">
            <StudyCommandButton
              commandId="study.save-checkpoint"
              disabledReason={commandDisabledReason("study.save-checkpoint")}
              icon={<Save size={13} />}
              label="Save"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.restore-checkpoint"
              disabledReason={commandDisabledReason("study.restore-checkpoint")}
              icon={<RotateCcw size={13} />}
              label="Restore"
              onRun={() => {
                setSelectedRestoreCheckpointId(
                  latestCheckpoint?.checkpoint_id ?? null,
                );
                setRestoreDialogOpen(true);
              }}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.import-state"
              disabledReason={commandDisabledReason("study.import-state")}
              icon={<Upload size={13} />}
              label="Import"
              onRun={() => setImportDialogOpen(true)}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.export-state"
              disabledReason={commandDisabledReason("study.export-state")}
              icon={<Download size={13} />}
              label="Export"
              onRun={runCommand}
              variant="ghost"
            />
            <StudyCommandButton
              commandId="study.discard-paused-state"
              disabledReason={commandDisabledReason("study.discard-paused-state")}
              icon={<Scissors size={13} />}
              label="Discard"
              onRun={runCommand}
              variant="danger"
            />
          </div>
        </InspectorSection>

        <InspectorSection
          value="history"
          title="Run History"
          badge={`${energyHistory.data?.returned_rows ?? 0}`}
        >
          <FieldRow
            label="Energy step"
            value={energyCurrent.data?.step ?? "not available"}
          />
          <FieldRow
            label="Total energy"
            value={
              typeof energyCurrent.data?.total === "number"
                ? energyCurrent.data.total.toExponential(4)
                : "not available"
            }
            unit="J"
          />
          <FieldRow
            label="Returned rows"
            value={energyHistory.data?.returned_rows ?? "not available"}
          />
          <FieldRow
            label="Total rows"
            value={energyHistory.data?.total_rows ?? "not available"}
          />
        </InspectorSection>
      </Accordion>
      <CommandDetailDialog
        commandId={selectedCommandId}
        detail={commandDetail}
        onOpenChange={(open) => {
          if (!open) setSelectedCommandId(null);
        }}
      />
      <RestoreCheckpointDialog
        checkpoints={checkpoints}
        open={restoreDialogOpen}
        selectedCheckpointId={selectedRestoreCheckpoint?.checkpoint_id ?? null}
        onConfirm={(checkpointId) => {
          setRestoreDialogOpen(false);
          setSelectedRestoreCheckpointId(checkpointId);
          runCommand("study.restore-checkpoint", { checkpointId });
        }}
        onOpenChange={setRestoreDialogOpen}
        onSelectCheckpoint={setSelectedRestoreCheckpointId}
      />
      <ImportStateDialog
        error={importError}
        fileName={importFileName}
        inspection={importInspection}
        inspecting={importInspecting}
        open={importDialogOpen}
        restoreMode={importRestoreMode}
        onConfirm={() => {
          if (!importFmsBase64) return;
          setImportDialogOpen(false);
          runCommand("study.import-state", {
            fmsBase64: importFmsBase64,
            restoreMode: importRestoreMode,
          });
        }}
        onFileSelected={(file) => {
          void inspectImportFile(file);
        }}
        onOpenChange={setImportDialogOpen}
        onRestoreModeChange={setImportRestoreMode}
      />
    </>
  );
}

export function StudyCommandButton({
  commandId,
  disabledReason,
  icon,
  label,
  onRun,
  variant,
}: {
  commandId: string;
  disabledReason: string | null;
  icon: ReactNode;
  label: string;
  onRun: (commandId: string) => void;
  variant?: "danger" | "ghost" | "primary" | "secondary";
}) {
  const enabled = disabledReason === null;
  const title = disabledReason ?? label;

  return (
    <Button
      size="sm"
      type="button"
      variant={variant}
      disabled={!enabled}
      aria-label={enabled ? label : `${label}: ${disabledReason}`}
      title={title}
      onClick={() => onRun(commandId)}
    >
      {icon}
      {label}
    </Button>
  );
}

export function RestoreCheckpointDialog({
  checkpoints,
  onConfirm,
  onOpenChange,
  onSelectCheckpoint,
  open,
  selectedCheckpointId,
}: {
  checkpoints: CheckpointEntry[];
  onConfirm: (checkpointId: string) => void;
  onOpenChange: (open: boolean) => void;
  onSelectCheckpoint: (checkpointId: string) => void;
  open: boolean;
  selectedCheckpointId: string | null;
}) {
  const checkpoint =
    checkpoints.find((entry) => entry.checkpoint_id === selectedCheckpointId) ??
    checkpoints[0] ??
    null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-study-command-dialog">
        <DialogHeader>
          <DialogTitle>Restore checkpoint</DialogTitle>
          <DialogDescription>
            {checkpoint
              ? `${checkpoint.resume_class} resume from ${checkpoint.checkpoint_id}`
              : "No checkpoint selected."}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          {checkpoints.length > 0 ? (
            <div className="fm-study-checkpoint-list" role="listbox">
              {checkpoints.map((entry) => (
                <button
                  key={entry.checkpoint_id}
                  className="fm-study-checkpoint-list__item"
                  data-selected={
                    entry.checkpoint_id === checkpoint?.checkpoint_id
                      ? "true"
                      : undefined
                  }
                  type="button"
                  role="option"
                  aria-selected={entry.checkpoint_id === checkpoint?.checkpoint_id}
                  onClick={() => onSelectCheckpoint(entry.checkpoint_id)}
                >
                  <span>{entry.checkpoint_id}</span>
                  <small>
                    {entry.resume_class} · step {entry.step}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
          <dl className="fm-dialog__details">
            <CommandDetailRow
              label="Checkpoint"
              value={checkpoint?.checkpoint_id ?? "—"}
            />
            <CommandDetailRow
              label="Resume class"
              value={checkpoint?.resume_class ?? "—"}
            />
            <CommandDetailRow label="Source" value={checkpoint?.source ?? "—"} />
            <CommandDetailRow
              label="Step"
              value={
                checkpoint?.step === null || checkpoint?.step === undefined
                  ? "—"
                  : String(checkpoint.step)
              }
            />
            <CommandDetailRow
              label="Stage ID"
              value={checkpoint?.stage_id ?? "—"}
            />
            <CommandDetailRow
              label="Command ID"
              value={checkpoint?.command_id ?? "—"}
            />
            <CommandDetailRow label="Run ID" value={checkpoint?.run_id ?? "—"} />
            <CommandDetailRow
              label="Backend"
              value={checkpoint?.backend_family ?? "—"}
            />
            <CommandDetailRow
              label="Mesh revision"
              value={
                checkpoint?.mesh_revision == null
                  ? "—"
                  : String(checkpoint.mesh_revision)
              }
            />
            <CommandDetailRow
              label="Field revision"
              value={
                checkpoint?.field_revision == null
                  ? "—"
                  : String(checkpoint.field_revision)
              }
            />
            <CommandDetailRow
              label="Scene revision"
              value={
                checkpoint?.scene_revision == null
                  ? "—"
                  : String(checkpoint.scene_revision)
              }
            />
            <CommandDetailRow
              label="Vector count"
              value={checkpoint ? String(checkpoint.vector_count) : "—"}
            />
            <CommandDetailRow
              label="Artifact"
              value={checkpoint?.artifact_ref ?? "—"}
            />
            <CommandDetailRow
              label="Checksum"
              value={checkpoint?.checksum ?? "—"}
            />
          </dl>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!checkpoint}
            onClick={() => {
              if (checkpoint) onConfirm(checkpoint.checkpoint_id);
            }}
          >
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportStateDialog({
  error,
  fileName,
  inspection,
  inspecting,
  onConfirm,
  onFileSelected,
  onOpenChange,
  onRestoreModeChange,
  open,
  restoreMode,
}: {
  error: string | null;
  fileName: string | null;
  inspection: SessionImportInspectResponse["inspection"] | null;
  inspecting: boolean;
  onConfirm: () => void;
  onFileSelected: (file: File | null) => void;
  onOpenChange: (open: boolean) => void;
  onRestoreModeChange: (mode: string) => void;
  open: boolean;
  restoreMode: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-study-command-dialog">
        <DialogHeader>
          <DialogTitle>Import state</DialogTitle>
          <DialogDescription>
            {fileName ?? "Choose a .fms file before committing import."}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          <input
            aria-label="FMS file"
            accept=".fms,application/octet-stream"
            className="fm-study-file-input"
            type="file"
            onChange={(event) => {
              onFileSelected(event.currentTarget.files?.[0] ?? null);
            }}
          />
          {inspecting ? (
            <p className="fm-dialog__description">Inspecting .fms file…</p>
          ) : null}
          {error ? <pre className="fm-dialog__error">{error}</pre> : null}
          {inspection ? (
            <>
              <dl className="fm-dialog__details">
                <CommandDetailRow label="Session" value={inspection.session_id} />
                <CommandDetailRow label="Name" value={inspection.name} />
                <CommandDetailRow
                  label="Restore class"
                  value={inspection.restore_class}
                />
                <CommandDetailRow label="Profile" value={inspection.profile} />
                <CommandDetailRow
                  label="Runs"
                  value={String(inspection.run_count)}
                />
                <CommandDetailRow
                  label="Size"
                  value={`${inspection.total_size_bytes} bytes`}
                />
                <CommandDetailRow label="Saved" value={inspection.saved_at} />
                <CommandDetailRow
                  label="Latest checkpoint"
                  value={inspection.latest_checkpoint?.checkpoint_id ?? "—"}
                />
                <CommandDetailRow
                  label="Checkpoint step"
                  value={
                    inspection.latest_checkpoint?.step == null
                      ? "—"
                      : String(inspection.latest_checkpoint.step)
                  }
                />
                <CommandDetailRow
                  label="Warnings"
                  value={
                    inspection.warnings.length > 0
                      ? inspection.warnings.join("; ")
                      : "—"
                  }
                />
              </dl>
              <label className="fm-study-select">
                <span>Restore mode</span>
                <select
                  value={restoreMode}
                  onChange={(event) => onRestoreModeChange(event.target.value)}
                >
                  <option value="resume">resume</option>
                  <option value="initial_condition">initial_condition</option>
                  <option value="config_only">config_only</option>
                </select>
              </label>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!inspection || inspecting}
            onClick={onConfirm}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommandDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fm-dialog__details-row">
      <dt className="fm-dialog__details-label">{label}</dt>
      <dd className="fm-dialog__details-value">{value}</dd>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read file."));
    };
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") {
        reject(new Error("Failed to read file as base64."));
        return;
      }
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}
