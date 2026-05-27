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
import { useReducer, type ReactNode } from "react";

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
  LiveStatusResource,
  SessionImportInspectResponse,
} from "@/kernel/api/apiTypes";
import {
  shouldLoadRuntimeCurrentRun,
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeScalars,
  shouldLoadRuntimeStageExecution,
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
  useSessionStatusSelector,
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
  type StudyInspectorModel,
  type StudyInspectorSnapshot,
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
        {stage.torqueToleranceShortFormatted ? (
          <span>tau {stage.torqueToleranceShortFormatted}</span>
        ) : null}
        {stage.energyTolerance ? <span>E {stage.energyTolerance}</span> : null}
        {stage.maxSteps ? <span>{stage.maxSteps} steps</span> : null}
        {stage.untilSeconds ? <span>{stage.untilSeconds} s</span> : null}
      </div>
    </div>
  );
}

interface StudyInspectorPanelState {
  importDialogOpen: boolean;
  importError: string | null;
  importFileName: string | null;
  importFmsBase64: string | null;
  importInspection: SessionImportInspectResponse["inspection"] | null;
  importInspecting: boolean;
  importRestoreMode: string;
  restoreDialogOpen: boolean;
  selectedCommandId: string | null;
  selectedRestoreCheckpointId: string | null;
}

type StudyInspectorPanelAction =
  | { type: "setImportDialogOpen"; open: boolean }
  | { type: "setImportRestoreMode"; mode: string }
  | { type: "setRestoreDialogOpen"; open: boolean }
  | { type: "setSelectedCommandId"; commandId: string | null }
  | { type: "setSelectedRestoreCheckpointId"; checkpointId: string | null }
  | { type: "prepareImportFile"; fileName: string | null }
  | {
      type: "importInspectSuccess";
      fmsBase64: string;
      inspection: SessionImportInspectResponse["inspection"];
    }
  | { type: "importInspectFailure"; message: string };

const STUDY_INSPECTOR_INITIAL_STATE: StudyInspectorPanelState = {
  importDialogOpen: false,
  importError: null,
  importFileName: null,
  importFmsBase64: null,
  importInspection: null,
  importInspecting: false,
  importRestoreMode: "resume",
  restoreDialogOpen: false,
  selectedCommandId: null,
  selectedRestoreCheckpointId: null,
};

function studyInspectorPanelReducer(
  state: StudyInspectorPanelState,
  action: StudyInspectorPanelAction,
): StudyInspectorPanelState {
  switch (action.type) {
    case "setImportDialogOpen":
      return { ...state, importDialogOpen: action.open };
    case "setImportRestoreMode":
      return { ...state, importRestoreMode: action.mode };
    case "setRestoreDialogOpen":
      return { ...state, restoreDialogOpen: action.open };
    case "setSelectedCommandId":
      return { ...state, selectedCommandId: action.commandId };
    case "setSelectedRestoreCheckpointId":
      return {
        ...state,
        selectedRestoreCheckpointId: action.checkpointId,
      };
    case "prepareImportFile":
      return {
        ...state,
        importError: null,
        importFileName: action.fileName,
        importFmsBase64: null,
        importInspection: null,
        importInspecting: action.fileName !== null,
      };
    case "importInspectSuccess":
      return {
        ...state,
        importError: null,
        importFmsBase64: action.fmsBase64,
        importInspection: action.inspection,
        importInspecting: false,
        importRestoreMode: action.inspection.restore_class ?? "resume",
      };
    case "importInspectFailure":
      return {
        ...state,
        importError: action.message,
        importInspecting: false,
      };
  }
}

type StudyInspectorRuntimeStatus = {
  capabilities: Pick<
    LiveStatusResource["capabilities"],
    "binary_fields" | "explicit_topology"
  >;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    | "mesh_build_revision"
    | "mesh_revision"
    | "scalars_revision"
    | "scene_revision"
    | "stages_revision"
  >;
  run: LiveStatusResource["run"];
};

function selectStudyInspectorRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): StudyInspectorRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      binary_fields: status.data.capabilities.binary_fields,
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      scalars_revision: status.data.resources.scalars_revision,
      scene_revision: status.data.resources.scene_revision,
      stages_revision: status.data.resources.stages_revision,
    },
    run: status.data.run,
  };
}

function studyInspectorRunEquals(
  previous: LiveStatusResource["run"],
  next: LiveStatusResource["run"],
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.run_id === next.run_id &&
    previous.solver_steps === next.solver_steps &&
    previous.solver_time === next.solver_time &&
    previous.stage_count === next.stage_count &&
    previous.stage_index === next.stage_index &&
    previous.stage_label === next.stage_label &&
    previous.started_at === next.started_at
  );
}

function studyInspectorRuntimeStatusEquals(
  previous: StudyInspectorRuntimeStatus | null,
  next: StudyInspectorRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.binary_fields === next.capabilities.binary_fields &&
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.scalars_revision === next.resources.scalars_revision &&
    previous.resources.scene_revision === next.resources.scene_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    studyInspectorRunEquals(previous.run, next.run)
  );
}

export function StudyInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const [state, dispatch] = useReducer(
    studyInspectorPanelReducer,
    STUDY_INSPECTOR_INITIAL_STATE,
  );
  const runtimeStatus = useSessionStatusSelector(
    selectStudyInspectorRuntimeStatus,
    { isEqual: studyInspectorRuntimeStatusEquals },
  );
  const scene = useSceneResource();
  const currentRun = useCurrentRunResource({
    enabled: shouldLoadRuntimeCurrentRun(true, runtimeStatus),
  });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(true, runtimeStatus),
  });
  const solverStatus = useSolverStatusResource();
  const commandQueue = useCommandQueueResource();
  const checkpointCatalog = useCheckpointCatalogResource();
  const geometryValidation = useGeometryValidationResource();
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const meshBuildLatest = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const meshManifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const meshSummary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const energyCurrent = useSolverEnergyCurrentResource({
    enabled: shouldLoadRuntimeScalars(true, runtimeStatus),
  });
  const energyHistory = useSolverEnergyHistoryResource(
    120,
    { enabled: shouldLoadRuntimeScalars(true, runtimeStatus) },
  );
  const commandDetail = useCommandDetailResource(state.selectedCommandId);
  const checkpoints = checkpointCatalog.data?.checkpoints ?? [];
  const latestCheckpoint = checkpoints[0] ?? null;
  const selectedRestoreCheckpoint =
    checkpoints.find(
      (checkpoint) =>
        checkpoint.checkpoint_id === state.selectedRestoreCheckpointId,
    ) ??
    latestCheckpoint ??
    null;
  const snapshot = studySnapshotFromScene(scene.data);
  const selectedStageRef =
    selection.ref?.type === "study-stage"
      ? {
          nodeId: selection.ref.nodeId,
          stageId: selection.ref.stageId,
          stageIndex: selection.ref.stageIndex,
        }
      : {
          nodeId: selection.nodeId,
        };
  const model = resolveStudyInspectorModel({
    commandQueue: commandQueue.data,
    currentRun: currentRun.data,
    energyHistory: energyHistory.data,
    selectedNodeId: selection.nodeId,
    selectedStageRef,
    snapshot,
    solverStatus: solverStatus.data,
    stageExecution: stageExecution.data,
  });
  const activeStageIndex = stageExecution.data?.active_stage_index ?? null;
  const commandContext = createCommandContext("inspector", kernel, {
    resourceData: {
      [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
      [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
      [MESHING_SUMMARY_PATH]: meshSummary.data,
      [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
      [MODEL_SCENE_PATH]: scene.data,
      [PERSISTENCE_CHECKPOINTS_PATH]: checkpointCatalog.data,
      [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
      [SIMULATION_COMMANDS_PATH]: commandQueue.data,
      [SIMULATION_RUN_CURRENT_PATH]: currentRun.data,
      [SIMULATION_SOLVER_STATUS_PATH]: solverStatus.data,
      [SIMULATION_STAGES_EXECUTION_PATH]: stageExecution.data,
    },
    sourceDetail: "study",
  });
  const runCommand = (commandId: string, input?: unknown) => {
    void kernel.commands.execute(commandId, commandContext, input);
  };
  const inspectImportFile = async (file: File | null) => {
    dispatch({
      type: "prepareImportFile",
      fileName: file?.name ?? null,
    });
    if (!file) return;

    try {
      const fmsBase64 = await readFileAsBase64(file);
      const inspection = await kernel.api.persistence.imports.inspect({
        fms_base64: fmsBase64,
      });
      dispatch({
        type: "importInspectSuccess",
        fmsBase64,
        inspection: inspection.inspection,
      });
    } catch (error) {
      dispatch({
        type: "importInspectFailure",
        message:
          error instanceof Error ? error.message : "Failed to inspect .fms file.",
      });
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
        <StudyRuntimeSection
          commandDisabledReason={commandDisabledReason}
          model={model}
          onOpenCommand={(commandId) =>
            dispatch({ type: "setSelectedCommandId", commandId })
          }
          runCommand={runCommand}
          stepValue={
            solverStatus.data?.step_index ?? currentRun.data?.total_steps ?? "n/a"
          }
        />

        <StudySelectedStageSection
          model={model}
          stageExecutionRevision={stageExecution.data?.revision ?? null}
        />

        <StudyBoundarySection model={model} snapshot={snapshot} />

        <StudyPipelineSection
          activeStageIndex={activeStageIndex}
          commandDisabledReason={commandDisabledReason}
          model={model}
          runCommand={runCommand}
        />

        <StudyRecoverySection
          checkpointCount={checkpointCatalog.data?.checkpoints.length ?? 0}
          commandDisabledReason={commandDisabledReason}
          latestCheckpoint={latestCheckpoint}
          onImport={() => dispatch({ type: "setImportDialogOpen", open: true })}
          onRestore={() => {
            dispatch({
              type: "setSelectedRestoreCheckpointId",
              checkpointId: latestCheckpoint?.checkpoint_id ?? null,
            });
            dispatch({ type: "setRestoreDialogOpen", open: true });
          }}
          runCommand={runCommand}
        />

        <StudyHistorySection
          energyStep={energyCurrent.data?.step ?? "not available"}
          returnedRows={energyHistory.data?.returned_rows ?? "not available"}
          totalEnergy={
            typeof energyCurrent.data?.total === "number"
              ? energyCurrent.data.total.toExponential(4)
              : "not available"
          }
          totalRows={energyHistory.data?.total_rows ?? "not available"}
        />
      </Accordion>
      <CommandDetailDialog
        commandId={state.selectedCommandId}
        detail={commandDetail}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "setSelectedCommandId", commandId: null });
          }
        }}
      />
      <RestoreCheckpointDialog
        checkpoints={checkpoints}
        open={state.restoreDialogOpen}
        selectedCheckpointId={selectedRestoreCheckpoint?.checkpoint_id ?? null}
        onConfirm={(checkpointId) => {
          dispatch({ type: "setRestoreDialogOpen", open: false });
          dispatch({
            type: "setSelectedRestoreCheckpointId",
            checkpointId,
          });
          runCommand("study.restore-checkpoint", { checkpointId });
        }}
        onOpenChange={(open) =>
          dispatch({ type: "setRestoreDialogOpen", open })
        }
        onSelectCheckpoint={(checkpointId) =>
          dispatch({
            type: "setSelectedRestoreCheckpointId",
            checkpointId,
          })
        }
      />
      <ImportStateDialog
        error={state.importError}
        fileName={state.importFileName}
        inspection={state.importInspection}
        inspecting={state.importInspecting}
        open={state.importDialogOpen}
        restoreMode={state.importRestoreMode}
        onConfirm={() => {
          if (!state.importFmsBase64) return;
          dispatch({ type: "setImportDialogOpen", open: false });
          runCommand("study.import-state", {
            fmsBase64: state.importFmsBase64,
            restoreMode: state.importRestoreMode,
          });
        }}
        onFileSelected={(file) => {
          void inspectImportFile(file);
        }}
        onOpenChange={(open) =>
          dispatch({ type: "setImportDialogOpen", open })
        }
        onRestoreModeChange={(mode) =>
          dispatch({ type: "setImportRestoreMode", mode })
        }
      />
    </>
  );
}

type StudyCommandRunner = (commandId: string, input?: unknown) => void;
type StudyCommandDisabledReason = (commandId: string) => string | null;

function StudyRuntimeSection({
  commandDisabledReason,
  model,
  onOpenCommand,
  runCommand,
  stepValue,
}: {
  commandDisabledReason: StudyCommandDisabledReason;
  model: StudyInspectorModel;
  onOpenCommand: (commandId: string) => void;
  runCommand: StudyCommandRunner;
  stepValue: ReactNode;
}) {
  return (
    <InspectorSection value="runtime" title="Runtime" badge={model.runtime.state}>
      <FieldRow label="Run" value={model.runtime.runId} />
      <FieldRow label="Active stage" value={model.runtime.activeStageLabel} />
      <FieldRow
        label="Command"
        value={
          model.runtime.commandId ? (
            <button
              type="button"
              className="fm-study-command-link"
              onClick={() => onOpenCommand(model.runtime.commandId ?? "")}
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
      {model.runtime.relaxTorqueStop ? (
        <>
          <FieldRow
            label="Relax torque"
            value={model.runtime.relaxTorqueStop.current}
          />
          <FieldRow
            label="Relax threshold"
            value={model.runtime.relaxTorqueStop.threshold}
          />
          <FieldRow
            label="Relax stop"
            value={model.runtime.relaxTorqueStop.status}
          />
        </>
      ) : null}
      {model.runtime.relaxEnergyStop ? (
        <>
          <FieldRow
            label="Energy plateau"
            value={model.runtime.relaxEnergyStop.current}
          />
          <FieldRow
            label="Energy threshold"
            value={model.runtime.relaxEnergyStop.threshold}
          />
          <FieldRow
            label="Energy stop"
            value={model.runtime.relaxEnergyStop.status}
          />
        </>
      ) : null}
      {model.runtime.relaxTimeStop ? (
        <>
          <FieldRow
            label="Physical time"
            value={model.runtime.relaxTimeStop.elapsed}
          />
          <FieldRow
            label="Time budget"
            value={model.runtime.relaxTimeStop.budget}
          />
          <FieldRow
            label="Time status"
            value={model.runtime.relaxTimeStop.status}
          />
        </>
      ) : null}
      <FieldRow label="Step" value={stepValue} />
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
  );
}

export function StudySelectedStageSection({
  model,
  stageExecutionRevision,
}: {
  model: StudyInspectorModel;
  stageExecutionRevision?: number | null;
}) {
  return (
    <InspectorSection
      value="selected-stage"
      title="Selected Stage"
      badge={model.selectedStage?.status ?? "none"}
    >
      <FieldRow label="Kind" value={model.selectedStage?.kind ?? "none"} />
      <FieldRow label="Status" value={model.selectedStage?.status ?? "none"} />
      <FieldRow
        label="Stop reason"
        value={model.selectedStage?.stopReason ?? "not available"}
      />
      <FieldRow
        label="Completed"
        value={model.selectedStage?.completedAtIso ?? "not completed"}
      />
      <FieldRow
        label="Command"
        value={model.selectedStage?.commandId ?? "not linked"}
      />
      {model.selectedStage?.runtimeMetric ? (
        <>
          <FieldRow
            label="Stop metric"
            value={model.selectedStage.runtimeMetric.name}
          />
          <FieldRow
            label="Metric value"
            value={model.selectedStage.runtimeMetric.value}
          />
          <FieldRow
            label="Metric threshold"
            value={model.selectedStage.runtimeMetric.threshold}
          />
        </>
      ) : null}
      <FieldRow
        label="Torque stop"
        value={model.selectedStage?.torqueToleranceFormatted ?? "not set"}
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
      <FieldRow
        label="Checkpoint"
        value={model.selectedStage?.checkpointRef ?? "not available"}
      />
      <FieldRow
        label="Artifacts"
        value={
          model.selectedStage?.artifactRefs.length
            ? model.selectedStage.artifactRefs.join(", ")
            : "none"
        }
      />
      <FieldRow
        label="Stage resource"
        value={
          stageExecutionRevision === undefined || stageExecutionRevision === null
            ? "not loaded"
            : `simulation/stages/execution@${stageExecutionRevision}`
        }
      />
      <ProgressBar
        label="Selected stage progress"
        value={model.selectedStage?.progressPercent ?? null}
      />
    </InspectorSection>
  );
}

function StudyBoundarySection({
  model,
  snapshot,
}: {
  model: StudyInspectorModel;
  snapshot: StudyInspectorSnapshot;
}) {
  return (
    <InspectorSection
      value="boundary"
      title="Boundary Conditions"
      badge={snapshot.requested.backend}
    >
      <FieldRow
        label="Demag realization"
        value={model.boundary.demagRealization}
      />
      <FieldRow label="External field" value={model.boundary.externalField} />
      <FieldRow label="Device" value={snapshot.requested.device} />
      <FieldRow label="Precision" value={snapshot.requested.precision} />
      <FieldRow label="Mode" value={snapshot.requested.mode} />
    </InspectorSection>
  );
}

function StudyPipelineSection({
  activeStageIndex,
  commandDisabledReason,
  model,
  runCommand,
}: {
  activeStageIndex: number | null;
  commandDisabledReason: StudyCommandDisabledReason;
  model: StudyInspectorModel;
  runCommand: StudyCommandRunner;
}) {
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
  );
}

function StudyRecoverySection({
  checkpointCount,
  commandDisabledReason,
  latestCheckpoint,
  onImport,
  onRestore,
  runCommand,
}: {
  checkpointCount: number;
  commandDisabledReason: StudyCommandDisabledReason;
  latestCheckpoint: CheckpointEntry | null;
  onImport: () => void;
  onRestore: () => void;
  runCommand: StudyCommandRunner;
}) {
  return (
    <InspectorSection
      value="recovery"
      title="Recovery"
      badge={`${checkpointCount}`}
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
          onRun={onRestore}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.import-state"
          disabledReason={commandDisabledReason("study.import-state")}
          icon={<Upload size={13} />}
          label="Import"
          onRun={onImport}
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
  );
}

function StudyHistorySection({
  energyStep,
  returnedRows,
  totalEnergy,
  totalRows,
}: {
  energyStep: ReactNode;
  returnedRows: ReactNode;
  totalEnergy: ReactNode;
  totalRows: ReactNode;
}) {
  return (
    <InspectorSection
      value="history"
      title="Run History"
      badge={`${returnedRows}`}
    >
      <FieldRow label="Energy step" value={energyStep} />
      <FieldRow label="Total energy" value={totalEnergy} unit="J" />
      <FieldRow label="Returned rows" value={returnedRows} />
      <FieldRow label="Total rows" value={totalRows} />
    </InspectorSection>
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
