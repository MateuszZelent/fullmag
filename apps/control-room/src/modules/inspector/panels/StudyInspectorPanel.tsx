"use client";

import {
  Download,
  Info,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
  SkipForward,
  Square,
  Upload,
} from "lucide-react";
import { useEffect, useReducer, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
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
  shouldLoadRuntimeCommandQueue,
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
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";

import {
  buildStudyGlobalMergePatch,
  createStudyGlobalDraft,
  validateStudyGlobalDraft,
  type StudyGlobalDraft,
} from "./StudyGlobalAuthoringModel";
import {
  buildStudyStagesMergePatch,
  createDefaultStudyStageDraft,
  createStudyStageDrafts,
  validateStudyStageDraft,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "./StudyStageAuthoringModel";
import {
  resolveStudyInspectorModel,
  studySnapshotFromScene,
  type StudyInspectorModel,
  type StudyInspectorSnapshot,
} from "./StudyInspectorPanelModel";
import {
  StudyPipelineSection,
  StudySolverPolicyFields,
} from "./StudyPipelineSection";
import { validateStudyWorkflow } from "./stages/studyWorkflowState";
import { StudyProgressBar } from "./StudyProgressBar";

export { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";

interface StudyInspectorPanelState {
  authoringBusy: boolean;
  authoringDraftsInitialized: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
  } | null;
  authoringFeedbackScope: "global" | "stages" | null;
  draftSceneRevision: number | string | null;
  draftSceneSignature: string;
  globalDraft: StudyGlobalDraft;
  importDialogOpen: boolean;
  importError: string | null;
  importFileName: string | null;
  importFmsBase64: string | null;
  importInspection: SessionImportInspectResponse["inspection"] | null;
  importInspecting: boolean;
  importRestoreMode: string;
  restoreDialogOpen: boolean;
  selectedDraftIndex: number;
  selectedCommandId: string | null;
  selectedRestoreCheckpointId: string | null;
  stageDrafts: StudyStageDraft[];
}

type StudyInspectorPanelAction =
  | {
      type: "resetStageDrafts";
      drafts: StudyStageDraft[];
      globalDraft: StudyGlobalDraft;
      revision: number | string | null;
      selectedIndex: number;
      signature: string;
    }
  | {
      type: "updateGlobalDraft";
      patch: Partial<StudyGlobalDraft>;
    }
  | { type: "selectStageDraft"; index: number }
  | {
      type: "updateStageDraft";
      index: number;
      patch: Partial<StudyStageDraft>;
    }
  | { type: "addStageDraft"; kind: StudyStageDraftKind }
  | { type: "duplicateStageDraft"; index: number }
  | { type: "removeStageDraft"; index: number }
  | { type: "moveStageDraft"; direction: -1 | 1; index: number }
  | { type: "setAuthoringBusy"; busy: boolean }
  | {
      type: "setAuthoringFeedback";
      feedback: StudyInspectorPanelState["authoringFeedback"];
      scope: StudyInspectorPanelState["authoringFeedbackScope"];
    }
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
  authoringBusy: false,
  authoringDraftsInitialized: false,
  authoringFeedback: null,
  authoringFeedbackScope: null,
  draftSceneRevision: null,
  draftSceneSignature: "",
  globalDraft: createStudyGlobalDraft(null),
  importDialogOpen: false,
  importError: null,
  importFileName: null,
  importFmsBase64: null,
  importInspection: null,
  importInspecting: false,
  importRestoreMode: "resume",
  restoreDialogOpen: false,
  selectedDraftIndex: 0,
  selectedCommandId: null,
  selectedRestoreCheckpointId: null,
  stageDrafts: [],
};

function studyInspectorPanelReducer(
  state: StudyInspectorPanelState,
  action: StudyInspectorPanelAction,
): StudyInspectorPanelState {
  switch (action.type) {
    case "resetStageDrafts":
      if (
        state.authoringDraftsInitialized &&
        state.draftSceneRevision === action.revision &&
        state.draftSceneSignature === action.signature
      ) {
        return state;
      }
      return {
        ...state,
        authoringBusy: false,
        authoringDraftsInitialized: true,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        draftSceneRevision: action.revision,
        draftSceneSignature: action.signature,
        globalDraft: action.globalDraft,
        selectedDraftIndex: action.selectedIndex,
        stageDrafts: action.drafts,
      };
    case "updateGlobalDraft":
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        globalDraft: { ...state.globalDraft, ...action.patch },
      };
    case "selectStageDraft":
      return {
        ...state,
        selectedDraftIndex: clampIndex(action.index, state.stageDrafts),
      };
    case "updateStageDraft":
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        stageDrafts: state.stageDrafts.map((draft, index) =>
          index === action.index ? { ...draft, ...action.patch } : draft,
        ),
      };
    case "addStageDraft": {
      const draft = createDefaultStudyStageDraft(
        action.kind,
        state.stageDrafts.length,
      );
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: state.stageDrafts.length,
        stageDrafts: [...state.stageDrafts, draft],
      };
    }
    case "duplicateStageDraft": {
      const source = state.stageDrafts[action.index];
      if (!source) return state;
      const draft = {
        ...source,
        stageId: `${source.stageId || source.kind}-copy`,
      };
      const stageDrafts = [...state.stageDrafts];
      stageDrafts.splice(action.index + 1, 0, draft);
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: action.index + 1,
        stageDrafts,
      };
    }
    case "removeStageDraft": {
      const stageDrafts = state.stageDrafts.filter(
        (_, index) => index !== action.index,
      );
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: clampIndex(action.index, stageDrafts),
        stageDrafts,
      };
    }
    case "moveStageDraft": {
      const targetIndex = action.index + action.direction;
      if (
        action.index < 0 ||
        targetIndex < 0 ||
        action.index >= state.stageDrafts.length ||
        targetIndex >= state.stageDrafts.length
      ) {
        return state;
      }
      const stageDrafts = [...state.stageDrafts];
      const [draft] = stageDrafts.splice(action.index, 1);
      stageDrafts.splice(targetIndex, 0, draft);
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: targetIndex,
        stageDrafts,
      };
    }
    case "setAuthoringBusy":
      return { ...state, authoringBusy: action.busy };
    case "setAuthoringFeedback":
      return {
        ...state,
        authoringFeedback: action.feedback,
        authoringFeedbackScope: action.scope,
      };
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

function clampIndex(index: number, drafts: readonly StudyStageDraft[]): number {
  if (drafts.length === 0) return 0;
  return Math.max(0, Math.min(index, drafts.length - 1));
}

function rawStudyStages(scene: unknown): unknown[] {
  const sceneRecord = asRecord(scene);
  const study = asRecord(sceneRecord?.study);
  return Array.isArray(study?.stages) ? study.stages : [];
}

function sceneRevisionValue(scene: unknown): number | string | null {
  const revision = asRecord(scene)?.revision;
  return typeof revision === "number" || typeof revision === "string"
    ? revision
    : null;
}

function studyAuthoringSignature(scene: unknown): string {
  return JSON.stringify(asRecord(scene)?.study ?? null);
}

function sceneHasAuthoringPayload(scene: unknown): boolean {
  const record = asRecord(scene);
  return Boolean(
    record &&
      ("study" in record ||
        "objects" in record ||
        "materials" in record ||
        "universe" in record ||
        "scene" in record ||
        "version" in record ||
        "current_modules" in record),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type StudyInspectorRuntimeStatus = {
  capabilities: Pick<
    LiveStatusResource["capabilities"],
    "algorithms_available" | "binary_fields" | "explicit_topology"
  >;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    | "mesh_build_revision"
    | "mesh_revision"
    | "commands_revision"
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
      algorithms_available: status.data.capabilities.algorithms_available,
      binary_fields: status.data.capabilities.binary_fields,
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      commands_revision: status.data.resources.commands_revision,
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
    previous.resources.commands_revision === next.resources.commands_revision &&
    previous.resources.scalars_revision === next.resources.scalars_revision &&
    previous.resources.scene_revision === next.resources.scene_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    studyInspectorRunEquals(previous.run, next.run)
  );
}

export function useStudyInspectorPanelController(
  selection: InspectorPanelProps["selection"],
) {
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
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(true, runtimeStatus),
  });
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
  const selectedStageIndex = model.selectedStage?.index ?? 0;
  const sceneRevision = sceneRevisionValue(scene.data);
  const sceneHasPayload = sceneHasAuthoringPayload(scene.data);
  const sceneStageCount = rawStudyStages(scene.data).length;
  const studySignature = studyAuthoringSignature(scene.data);
  useEffect(() => {
    if (!scene.data) return;
    if (!sceneHasAuthoringPayload(scene.data)) return;
    const rawStages = rawStudyStages(scene.data);
    const stageDrafts = createStudyStageDrafts(rawStages);
    dispatch({
      type: "resetStageDrafts",
      drafts: stageDrafts,
      globalDraft: createStudyGlobalDraft(scene.data),
      revision: sceneRevision,
      selectedIndex:
        stageDrafts.length === 0
          ? 0
          : Math.min(selectedStageIndex, stageDrafts.length - 1),
      signature: studySignature,
    });
  }, [scene.data, sceneRevision, selectedStageIndex, studySignature]);
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
  const commitStageDrafts = async () => {
    const localIssues = state.stageDrafts.flatMap((draft, index) =>
      validateStudyStageDraft(draft, {
        algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
        backend: model.requested.backend,
        demagEnabled: state.globalDraft.demagEnabled,
        device: model.requested.device,
        mode: model.requested.mode,
        precision: state.globalDraft.requestedPrecision,
      }).map((issue) => ({
        ...issue,
        message: `Stage ${index + 1}: ${issue.message}`,
      })),
    );
    const workflowIssues = validateStudyWorkflow(state.stageDrafts).map(
      (issue) => ({
        ...issue,
        message: `Stage ${issue.index + 1}: ${issue.message}`,
      }),
    );
    const issues = [...localIssues, ...workflowIssues];
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "stages",
        feedback: {
          kind: "error",
          message: errors.map((issue) => issue.message).join(" "),
        },
      });
      return;
    }

    dispatch({ type: "setAuthoringBusy", busy: true });
    try {
      const response = await kernel.api.model.commitTransaction(
        buildStudyStagesMergePatch(state.stageDrafts),
      );
      const revision = response.scene_revision;
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
      kernel.resources.invalidate(SIMULATION_COMMANDS_PATH, revision);
      dispatch({
        type: "setAuthoringFeedback",
        scope: "stages",
        feedback: {
          kind: "success",
          message: `Committed ${state.stageDrafts.length} study stage${state.stageDrafts.length === 1 ? "" : "s"}.`,
        },
      });
    } catch (error) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "stages",
        feedback: {
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to commit study stages.",
        },
      });
    } finally {
      dispatch({ type: "setAuthoringBusy", busy: false });
    }
  };
  const commitGlobalDraft = async () => {
    const errors = validateStudyGlobalDraft(state.globalDraft, {
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
    }).filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length > 0) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "global",
        feedback: {
          kind: "error",
          message: errors.map((issue) => issue.message).join(" "),
        },
      });
      return;
    }

    dispatch({ type: "setAuthoringBusy", busy: true });
    try {
      const response = await kernel.api.model.commitTransaction(
        buildStudyGlobalMergePatch(state.globalDraft),
      );
      const revision = response.scene_revision;
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
      kernel.resources.invalidate(SIMULATION_COMMANDS_PATH, revision);
      dispatch({
        type: "setAuthoringFeedback",
        scope: "global",
        feedback: {
          kind: "success",
          message: "Committed global study settings.",
        },
      });
    } catch (error) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "global",
        feedback: {
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to commit global study settings.",
        },
      });
    } finally {
      dispatch({ type: "setAuthoringBusy", busy: false });
    }
  };

  return {
    activeStageIndex,
    checkpointCatalog,
    checkpoints,
    commandDetail,
    commandDisabledReason,
    commitGlobalDraft,
    commitStageDrafts,
    currentRun,
    dispatch,
    energyCurrent,
    energyHistory,
    inspectImportFile,
    latestCheckpoint,
    model,
    runtimeStatus,
    runCommand,
    scene,
    sceneHasPayload,
    sceneRevision,
    sceneStageCount,
    selectedRestoreCheckpoint,
    snapshot,
    solverStatus,
    stageExecution,
    state,
  };
}

export function StudyInspectorPanel({ selection }: InspectorPanelProps) {
  const {
    activeStageIndex,
    checkpointCatalog,
    checkpoints,
    commandDetail,
    commandDisabledReason,
    commitGlobalDraft,
    commitStageDrafts,
    currentRun,
    dispatch,
    energyCurrent,
    energyHistory,
    inspectImportFile,
    latestCheckpoint,
    model,
    runtimeStatus,
    runCommand,
    scene,
    sceneHasPayload,
    sceneRevision,
    sceneStageCount,
    selectedRestoreCheckpoint,
    snapshot,
    solverStatus,
    stageExecution,
    state,
  } = useStudyInspectorPanelController(selection);

  return (
    <>
      <Accordion
        className="fm-inspector-panel"
        data-scene-has-payload={sceneHasPayload}
        data-scene-revision={sceneRevision ?? ""}
        data-scene-stage-count={sceneStageCount}
        data-scene-status={scene.status}
        data-stage-draft-count={state.stageDrafts.length}
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

        <StudyBoundarySection
          algorithmsAvailable={runtimeStatus?.capabilities.algorithms_available}
          authoringBusy={state.authoringBusy}
          authoringFeedback={
            state.authoringFeedbackScope === "global"
              ? state.authoringFeedback
              : null
          }
          draft={state.globalDraft}
          model={model}
          snapshot={snapshot}
          onCommit={() => void commitGlobalDraft()}
          onUpdate={(patch) =>
            dispatch({ type: "updateGlobalDraft", patch })
          }
        />

        <StudyPipelineSection
          activeStageIndex={activeStageIndex}
          algorithmsAvailable={runtimeStatus?.capabilities.algorithms_available}
          authoringBusy={state.authoringBusy}
          authoringFeedback={
            state.authoringFeedbackScope === "stages"
              ? state.authoringFeedback
              : null
          }
          commandDisabledReason={commandDisabledReason}
          demagEnabled={state.globalDraft.demagEnabled}
          draft={state.stageDrafts[state.selectedDraftIndex] ?? null}
          draftIndex={state.selectedDraftIndex}
          drafts={state.stageDrafts}
          model={model}
          onAddStage={(kind) => dispatch({ type: "addStageDraft", kind })}
          onCommit={() => void commitStageDrafts()}
          onDuplicateStage={(index) =>
            dispatch({ type: "duplicateStageDraft", index })
          }
          onMoveStage={(index, direction) =>
            dispatch({ type: "moveStageDraft", index, direction })
          }
          onRemoveStage={(index) => dispatch({ type: "removeStageDraft", index })}
          onSelectDraft={(index) => dispatch({ type: "selectStageDraft", index })}
          onUpdateDraft={(index, patch) =>
            dispatch({ type: "updateStageDraft", index, patch })
          }
          runCommand={runCommand}
          showDraftEditor={false}
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
      {model.runtime.backendDiagnostic ? (
        <FieldRow label="Backend failure" value={model.runtime.backendDiagnostic} />
      ) : null}
      {model.runtime.warnings?.map((warning, index) => (
        <FieldRow key={`${index}:${warning}`} label="Runtime warning" value={warning} />
      ))}
      <FieldRow label="Max torque" value={model.runtime.maxTorque} />
      {model.runtime.torqueDiagnostic ? (
        <FieldRow label="Torque diagnostic" value={model.runtime.torqueDiagnostic} />
      ) : null}
      <FieldRow
        label="Max RHS norm"
        value={model.runtime.maxRhsNorm ?? "unavailable"}
      />
      <FieldRow
        label="Converged"
        value={model.runtime.converged ?? "not reported"}
      />
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
      <StudyProgressBar
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
  const selectedStage = model.selectedStage;
  const eigenmodeSolving =
    selectedStage !== null &&
    selectedStage.kind.toLowerCase().includes("eigen") &&
    ["accepted", "dispatched", "materializing", "pending", "queued", "running"].includes(
      selectedStage.status.toLowerCase(),
    );
  const selectedStageHasProgress =
    selectedStage !== null &&
    (selectedStage.progressLabel != null ||
      selectedStage.progressDetail != null ||
      selectedStage.progressPercent > 0);
  const selectedStageProgressValue =
    eigenmodeSolving && !selectedStageHasProgress
      ? null
      : (selectedStage?.progressPercent ?? null);
  const selectedStageProgressLabel =
    selectedStage?.progressLabel ??
    (eigenmodeSolving ? "waiting for solver progress telemetry" : undefined);

  return (
    <InspectorSection
      value="selected-stage"
      title="Selected Stage"
      badge={selectedStage?.status ?? "none"}
    >
      <FieldRow label="Kind" value={selectedStage?.kind ?? "none"} />
      <FieldRow label="Status" value={selectedStage?.status ?? "none"} />
      {eigenmodeSolving ? (
        <FieldRow
          label="Eigenmode solve progress"
          value={selectedStageProgressLabel}
        />
      ) : null}
      {selectedStage?.progressDetail ? (
        <FieldRow label="Progress detail" value={selectedStage.progressDetail} />
      ) : null}
      <FieldRow
        label="Stop reason"
        value={selectedStage?.stopReason ?? "not available"}
      />
      <FieldRow
        label="Completed"
        value={selectedStage?.completedAtIso ?? "not completed"}
      />
      <FieldRow
        label="Command"
        value={selectedStage?.commandId ?? "not linked"}
      />
      {selectedStage?.transition ? (
        <>
          <FieldRow
            label="State transition"
            value={selectedStage.transition.label ?? "declared"}
          />
          <FieldRow
            label="Transition kind"
            value={selectedStage.transition.kind ?? "not available"}
          />
          <FieldRow
            label="Transition reason"
            value={selectedStage.transition.reason ?? "not available"}
          />
          <FieldRow
            label="Transfer operator"
            value={selectedStage.transition.transferOperator ?? "not available"}
          />
        </>
      ) : null}
      {selectedStage?.runtimeMetric ? (
        <>
          <FieldRow
            label="Stop metric"
            value={selectedStage.runtimeMetric.name}
          />
          <FieldRow
            label="Metric value"
            value={selectedStage.runtimeMetric.value}
          />
          <FieldRow
            label="Metric threshold"
            value={selectedStage.runtimeMetric.threshold}
          />
        </>
      ) : null}
      <FieldRow
        label="Torque stop"
        value={selectedStage?.torqueToleranceFormatted ?? "not set"}
      />
      <FieldRow
        label="Energy stop"
        value={selectedStage?.energyTolerance ?? "not set"}
      />
      <FieldRow
        label="Step budget"
        value={selectedStage?.maxSteps ?? "not set"}
      />
      <FieldRow
        label="Time budget"
        value={selectedStage?.untilSeconds ?? "not set"}
        unit={selectedStage?.untilSeconds ? "s" : undefined}
      />
      <FieldRow
        label="Checkpoint"
        value={selectedStage?.checkpointRef ?? "not available"}
      />
      <FieldRow
        label="Artifacts"
        value={
          selectedStage?.artifactRefs.length
            ? selectedStage.artifactRefs.join(", ")
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
      <StudyProgressBar
        indeterminate={eigenmodeSolving && !selectedStageHasProgress}
        label={
          eigenmodeSolving
            ? "Eigenmode solve progress"
            : "Selected stage progress"
        }
        statusLabel={selectedStage?.progressLabel ?? undefined}
        value={selectedStageProgressValue}
      />
    </InspectorSection>
  );
}

export function StudyBoundarySection({
  algorithmsAvailable,
  authoringBusy,
  authoringFeedback,
  draft,
  model,
  onCommit,
  onUpdate,
  snapshot,
}: {
  algorithmsAvailable?: readonly string[];
  authoringBusy: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
  } | null;
  draft: StudyGlobalDraft;
  model: StudyInspectorModel;
  onCommit: () => void;
  onUpdate: (patch: Partial<StudyGlobalDraft>) => void;
  snapshot: StudyInspectorSnapshot;
}) {
  const validation = validateStudyGlobalDraft(draft, { algorithmsAvailable });
  const hasErrors = validation.some((issue) => issue.severity === "error");
  return (
    <InspectorSection
      value="boundary"
      title="Global Study Settings"
      badge={snapshot.requested.backend}
    >
      <FieldRow label="Current exchange" value={model.boundary.exchangeEnabled} />
      <FieldRow label="Current demag term" value={model.boundary.demagEnabled} />
      <FieldRow label="Current demag" value={model.boundary.demagRealization} />
      <FieldRow label="Current field" value={model.boundary.externalField} />
      <FieldRow label="Current solver" value={model.boundary.solver} />
      <FieldRow
        label="Current FEM demag policy"
        value={model.boundary.femDemagSolverPolicy}
      />
      <FieldRow label="Current CPU threads" value={model.requested.cpuThreads} />
      <FormField
        label="Backend"
        type="select"
        value={draft.requestedBackend}
        onChange={(event) =>
          onUpdate({ requestedBackend: event.target.value })
        }
      >
        <option value="auto">Auto</option>
        <option value="fdm">FDM</option>
        <option value="fem">FEM</option>
        <option value="hybrid">Hybrid</option>
      </FormField>
      <FormField
        label="Device"
        type="select"
        value={draft.requestedDevice}
        onChange={(event) => onUpdate({ requestedDevice: event.target.value })}
      >
        <option value="auto">Auto</option>
        <option value="cpu">CPU</option>
        <option value="gpu">GPU</option>
      </FormField>
      <FormField
        label="Precision"
        type="select"
        value={draft.requestedPrecision}
        onChange={(event) =>
          onUpdate({ requestedPrecision: event.target.value })
        }
      >
        <option value="double">Double</option>
        <option value="single">Single</option>
      </FormField>
      <FormField
        label="Mode"
        type="select"
        value={draft.requestedMode}
        onChange={(event) => onUpdate({ requestedMode: event.target.value })}
      >
        <option value="strict">Strict</option>
        <option value="extended">Extended</option>
        <option value="hybrid">Hybrid</option>
      </FormField>
      <FormField
        label="CPU threads"
        hint="Blank keeps automatic runtime thread selection."
        value={draft.requestedCpuThreads}
        onChange={(event) =>
          onUpdate({ requestedCpuThreads: event.target.value })
        }
      />
      <FormField
        label="Exchange enabled"
        checked={draft.exchangeEnabled}
        type="checkbox"
        onChange={(event) => onUpdate({ exchangeEnabled: event.target.checked })}
      />
      <FormField
        label="Demag enabled"
        checked={draft.demagEnabled}
        type="checkbox"
        onChange={(event) => onUpdate({ demagEnabled: event.target.checked })}
      />
      <FormField
        label="Demag"
        type="select"
        value={draft.demagRealization}
        onChange={(event) => onUpdate({ demagRealization: event.target.value })}
      >
        <option value="auto">Auto</option>
        <option value="poisson_robin">Poisson Robin</option>
        <option value="poisson_dirichlet">Poisson Dirichlet</option>
        <option value="fredkin_koehler">Fredkin Koehler</option>
        <option value="bem">BEM</option>
        <option value="fmm">FMM</option>
        <option value="airbox_robin">Airbox Robin</option>
      </FormField>
      <FormField
        label="External field"
        hint="B_ext vector in T. Leave blank to remove the global field."
        unit="T"
        value={draft.externalField}
        onChange={(event) => onUpdate({ externalField: event.target.value })}
      />
      <StudySolverPolicyFields
        algorithmsAvailable={algorithmsAvailable}
        draft={draft.solver}
        onUpdate={(patch) =>
          onUpdate({ solver: { ...draft.solver, ...patch } })
        }
        requestedBackend={draft.requestedBackend}
        requestedDevice={draft.requestedDevice}
        requestedPrecision={draft.requestedPrecision}
      />
      <FormField
        label="FEM demag policy"
        hint="FEM demag solver policy JSON object."
        rows={4}
        type="textarea"
        value={draft.femDemagSolverPolicy}
        onChange={(event) =>
          onUpdate({ femDemagSolverPolicy: event.target.value })
        }
      />
      {validation.length > 0 ? (
        <ul className="fm-inspector-validation-list">
          {validation.map((issue) => (
            <li key={`${issue.severity}:${issue.message}`}>
              {issue.severity}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {authoringFeedback ? (
        <FeedbackBanner
          kind={authoringFeedback.kind}
          message={authoringFeedback.message}
        />
      ) : null}
      <div className="fm-inspector-toolbar">
        <Button
          disabled={authoringBusy || hasErrors}
          size="sm"
          title={
            hasErrors
              ? "Fix global study validation errors before saving."
              : "Save global study settings"
          }
          type="button"
          variant="primary"
          onClick={onCommit}
        >
          <Save size={13} aria-hidden="true" />
          {authoringBusy ? "Saving" : "Save globals"}
        </Button>
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
      <DialogContent className="fm-study-command-dialog" aria-describedby="fm-restore-checkpoint-description">
        <DialogHeader>
          <DialogTitle>Restore checkpoint</DialogTitle>
          <DialogDescription id="fm-restore-checkpoint-description">
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
      <DialogContent className="fm-study-command-dialog" aria-describedby="fm-import-state-description">
        <DialogHeader>
          <DialogTitle>Import state</DialogTitle>
          <DialogDescription id="fm-import-state-description">
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
