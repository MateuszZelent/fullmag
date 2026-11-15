"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandResult } from "@/kernel/commands/commandTypes";
import { studyComputeDraftBlockedReason } from "@/kernel/authoring/studyComputeDraftGuard";
import { useLayoutSelector } from "@/kernel/layout/useLayout";
import { runFdmGridRefreshOperation } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  SIMULATION_STAGES_RESULTS_PATH,
} from "@/kernel/api/apiPaths";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type {
  AuthoringTransactionResponse,
  CheckpointEntry,
  FrequencyDomainManifestResource,
  MeshPeriodicPairsResource,
  MeshSharedDomainManifestResource,
  SceneResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import {
  shouldLoadRuntimeCurrentRun,
  shouldLoadRuntimeCommandQueue,
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeScalars,
  shouldLoadRuntimeStageExecution,
  buildRuntimeCommandControlResourceData,
  useCommandQueueResource,
  useCommandDetailResource,
  useCheckpointCatalogResource,
  useCurrentRunResource,
  useModelReadinessResource,
  useSolverEnergyCurrentResource,
  useSolverEnergyHistoryResource,
  useSolverStatusResource,
  useStageExecutionResource,
  useFrequencyDomainManifestResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  invalidateFdmGridResources,
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession, type InspectorEditSession } from "../InspectorEditSession";
import { InspectorMetricStrip } from "../primitives/InspectorMetricStrip";
import { ProjectRunsSection } from "./ProjectRunsSection";
import { ProjectBatchesSection } from "./ProjectBatchesSection";
import {
  buildStudyGlobalMergePatch,
  createStudyGlobalDraft,
  isExplicitFdmStudy,
  validateStudyGlobalDraft,
} from "./StudyGlobalAuthoringModel";
import {
  buildStudyPipelineStageMergePatch,
  buildStudyStagesMergePatch,
  createStudyStageDrafts,
  readStageTextureAssignments,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "./StudyStageAuthoringModel";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";
import { createPipelineStudyStageDrafts } from "./studyPipelineStageDrafts";
import {
  resolveStudyInspectorModel,
  stageExecutionForCurrentScope,
  studySnapshotFromScene,
} from "./StudyInspectorPanelModel";
import { StudyPipelineSection } from "./StudyPipelineSection";
import { StudyExecutionProfileSection, type StudyExecutionProfileEditSession } from "./StudyExecutionProfileSection";
import {
  buildStudyExecutionProfileAssignmentMergePatch,
  hasChangeDeviceStudyStage,
  hasStudyExecutionProfile,
  type StudyExecutionProfileAssignment,
} from "./StudyExecutionProfileModel";
import type { K0ModalExecutionReadiness } from "./StudyStageAuthoringModel";
import { validateStudyWorkflow } from "./stages/studyWorkflowState";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import { captureStudyComputeInput } from "@/kernel/runtime/studyComputeInput";
import { executeStageAfterApply, type StageApplyRunPin } from "./studyStageApplyAndRun";
export { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import {
  RestoreCheckpointDialog,
  ImportStateDialog,
  readFileAsBase64,
} from "./StudyInspectorDialogs";
import {
  StudyRuntimeSection,
  StudySelectedStageSection,
  StudyBoundarySection,
  StudyRecoverySection,
  StudyHistorySection,
} from "./StudyInspectorSections";
import {
  STUDY_INSPECTOR_INITIAL_STATE,
  studyInspectorPanelReducer,
} from "./studyInspectorPanelState";
import {
  selectStudyInspectorRuntimeStatus,
  studyInspectorRuntimeStatusEquals,
} from "./studyInspectorRuntimeStatus";
import {
  rawStudyStages,
  magneticObjectCount,
  magneticObjectIds,
  numericSceneRevision,
  asRecord,
} from "./studyInspectorShared";
export {
  studyInspectorPanelReducer,
} from "./studyInspectorPanelState";
export {
  studyInspectorRuntimeStatusEquals,
} from "./studyInspectorRuntimeStatus";
export {
  StudyRuntimeSection,
  StudySelectedStageSection,
  StudyBoundarySection,
  StudyCommandButton,
} from "./StudyInspectorSections";
export {
  RestoreCheckpointDialog,
  ImportStateDialog,
} from "./StudyInspectorDialogs";

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

const PRODUCTION_CAPABILITY_STATUSES = new Set([
  "production",
  "production_qualified",
  "qualified",
]);

/**
 * Keeps K0 authoring gates tied to revisioned HTTP resources instead of an
 * optimistic local form flag. Unknown resources stay unavailable.
 */
export function deriveK0ModalExecutionReadiness({
  checkpoints,
  equilibriumArtifact,
  equilibriumSource,
  frequencyManifest,
  meshManifest,
  periodicPairs,
  solverStatus,
  stageExecution,
}: {
  checkpoints: readonly CheckpointEntry[];
  equilibriumArtifact: string;
  equilibriumSource: string;
  frequencyManifest: FrequencyDomainManifestResource | null;
  meshManifest: MeshSharedDomainManifestResource | null;
  periodicPairs: MeshPeriodicPairsResource | null;
  solverStatus: SolverStatusResource | null;
  stageExecution: StageExecutionResource | null;
}): K0ModalExecutionReadiness {
  const sharedDomainMeshReady = Boolean(
    meshManifest?.mesh_id && meshManifest.revision >= 0,
  );
  const periodicCertificateReady = Boolean(
    periodicPairs &&
      periodicPairs.pairs.length > 0 &&
      periodicPairs.pairs.every(
        (pair) =>
          pair.paired_node_count > 0 &&
          pair.unpaired_destination_node_count === 0 &&
          pair.unpaired_source_node_count === 0 &&
          ["certified", "matched", "valid"].includes(pair.status),
      ),
  );
  const acceptedRelaxationReady = Boolean(
    stageExecution?.stages.some((stage) =>
      stage.kind === "relax" &&
      stage.converged &&
      ["accepted", "completed"].includes(stage.status),
    ),
  );
  const acceptedArtifactReady = Boolean(
    equilibriumArtifact.trim() &&
      checkpoints.some(
        (checkpoint) =>
          checkpoint.artifact_ref === equilibriumArtifact.trim() &&
          checkpoint.mesh_revision === meshManifest?.revision,
      ),
  );
  const acceptedProvidedStateReady = Boolean(
    solverStatus &&
      solverStatus.converged &&
      !solverStatus.is_busy &&
      solverStatus.revision >= 0,
  );
  const acceptedEquilibriumReady =
    equilibriumSource === "relax"
      ? acceptedRelaxationReady
      : equilibriumSource === "provided"
        ? acceptedProvidedStateReady
        : equilibriumSource === "artifact"
          ? acceptedArtifactReady
          : false;
  const strictGpuReady = PRODUCTION_CAPABILITY_STATUSES.has(
    frequencyManifest?.capabilities.modal.production_gpu.status ?? "",
  );

  return {
    acceptedEquilibriumReady,
    periodicCertificateReady,
    sharedDomainMeshReady,
    strictGpuReady,
  };
}

const PARTIAL_STUDY_APPLY_MESSAGE =
  "Global Study settings were committed. The Pipeline stage save could not be confirmed. Review the current scene and Pipeline feedback before retrying Apply.";

function partialStudyApplyError(cause?: unknown): Error {
  const detail = cause instanceof Error ? " Stage save error: " + cause.message : "";
  return new Error(PARTIAL_STUDY_APPLY_MESSAGE + detail);
}

export async function applyStudyDraftsWithPartialFailure({
  globalDirty,
  stagesDirty,
  commitGlobal,
  commitStages,
}: {
  globalDirty: boolean;
  stagesDirty: boolean;
  commitGlobal: () => Promise<boolean>;
  commitStages: () => Promise<boolean>;
}): Promise<boolean> {
  let globalCommitted = false;
  if (globalDirty) {
    globalCommitted = await commitGlobal();
    if (!globalCommitted) return false;
  }

  if (stagesDirty) {
    let stagesCommitted: boolean;
    try {
      stagesCommitted = await commitStages();
    } catch (error) {
      if (globalCommitted) throw partialStudyApplyError(error);
      throw error;
    }
    if (!stagesCommitted) {
      if (globalCommitted) throw partialStudyApplyError();
      return false;
    }
  }

  return true;
}

export function useStudyInspectorPanelController(
  selection: InspectorPanelProps["selection"],
) {
  const kernel = useKernel();
  const commands = kernel.commands;
  const subscribeCommands = useCallback((listener: () => void) => commands.subscribe(listener), [commands]);
  const getCommandVersion = useCallback(() => commands.getVersion(), [commands]);
  useSyncExternalStore(subscribeCommands, getCommandVersion, getCommandVersion);
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const [state, dispatch] = useReducer(
    studyInspectorPanelReducer,
    STUDY_INSPECTOR_INITIAL_STATE,
  );
  const importInspectionGeneration = useRef(0);
  const importScopeRef = useRef(sessionScopeKey);
  const selectedAuthoringTargetKey = selection.ref?.type === "study-stage"
    ? JSON.stringify(["study-stage", selection.ref.nodeId, selection.ref.stageId])
    : JSON.stringify(["node", selection.nodeId]);
  const selectedAuthoringTargetRef = useRef(selectedAuthoringTargetKey);
  useEffect(() => {
    if (selectedAuthoringTargetRef.current === selectedAuthoringTargetKey) return;
    selectedAuthoringTargetRef.current = selectedAuthoringTargetKey;
    dispatch({ type: "clearStageAuthoringFeedback" });
  }, [dispatch, selectedAuthoringTargetKey]);
  useEffect(() => {
    if (importScopeRef.current === sessionScopeKey) return;
    importScopeRef.current = sessionScopeKey;
    importInspectionGeneration.current += 1;
    dispatch({ type: "prepareImportFile", fileName: null });
    dispatch({ type: "setImportDialogOpen", open: false });
  }, [sessionScopeKey]);
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
  const scopedStageExecutionData = stageExecutionForCurrentScope(
    stageExecution.data,
    {
      expectedRunId: runtimeStatus?.run?.run_id ?? null,
      expectedSessionEpoch: runtimeStatus?.session.session_epoch ?? null,
      expectedSessionId: runtimeStatus?.session.session_id ?? null,
      resourceStatus: stageExecution.status,
      scopeReady: runtimeStatus !== null,
    },
  );
  const scopedStageExecution =
    scopedStageExecutionData === stageExecution.data
      ? stageExecution
      : { ...stageExecution, data: scopedStageExecutionData };
  const solverStatus = useSolverStatusResource();
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(true, runtimeStatus),
  });
  const checkpointCatalog = useCheckpointCatalogResource();
  const geometryValidation = useGeometryValidationResource();
  const modelReadiness = useModelReadinessResource();
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
  const periodicPairs = useMeshPeriodicPairsResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const frequencyDomainManifest = useFrequencyDomainManifestResource({
    enabled: shouldLoadRuntimeStageExecution(true, runtimeStatus),
  });
  const energyCurrent = useSolverEnergyCurrentResource({
    enabled: shouldLoadRuntimeScalars(true, runtimeStatus),
  });
  // The Inspector stays mounted while hidden; its 120-row energy window would
  // otherwise refetch on every scalar row of a running solve.
  const inspectorVisible = useLayoutSelector((layout) => layout.panelVisible.right);
  const energyHistory = useSolverEnergyHistoryResource(
    120,
    { enabled: inspectorVisible && shouldLoadRuntimeScalars(true, runtimeStatus) },
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
    activeLane: runtimeStatus?.capabilities.active_lane ?? null,
    commandQueue: commandQueue.data,
    currentRun: currentRun.data,
    energyHistory: energyHistory.data,
    selectedNodeId: selection.nodeId,
    selectedStageRef,
    snapshot,
    solverStatus: solverStatus.data,
    stageExecution: scopedStageExecutionData,
  });
  const selectedStageIndex = model.selectedStage?.index ?? 0;
  const k0ModalReadinessFor = (draft: StudyStageDraft) =>
    deriveK0ModalExecutionReadiness({
      checkpoints,
      equilibriumArtifact: draft.equilibriumArtifact,
      equilibriumSource: draft.equilibriumSource,
      frequencyManifest: frequencyDomainManifest.data,
      meshManifest: meshManifest.data,
      periodicPairs: periodicPairs.data,
      solverStatus: solverStatus.data,
      stageExecution: scopedStageExecutionData,
    });
  const sceneRevision = sceneRevisionValue(scene.data);
  const authoringScopeKey = `${sessionScopeKey ?? "no-session"}:${kernel.api.resourceCacheScope}`;
  const acknowledgedSceneRevisionRef = useRef<number | null>(null);
  const stageSaveInFlight = useRef(false);
  const stageApplyRun = useRef<{
    pin: StageApplyRunPin;
    receipt: AuthoringTransactionResponse | null;
  } | null>(null);
  const authoritativeSceneRef = useRef<SceneResource | null>(scene.data);
  const authoritativeScopeRef = useRef(authoringScopeKey);
  const authoritativeSnapshotScopeRef = useRef<string | null>(
    scene.status === "ready" ? authoringScopeKey : null,
  );
  useEffect(() => {
    if (authoritativeScopeRef.current !== authoringScopeKey) {
      authoritativeScopeRef.current = authoringScopeKey;
      authoritativeSceneRef.current = null;
      authoritativeSnapshotScopeRef.current = null;
      acknowledgedSceneRevisionRef.current = null;
      return;
    }
    if (scene.status !== "ready") return;
    const observedRevision = numericSceneRevision(sceneRevision);
    if (
      scene.data &&
      observedRevision !== null &&
      (acknowledgedSceneRevisionRef.current === null ||
        observedRevision >= acknowledgedSceneRevisionRef.current)
    ) {
      authoritativeSceneRef.current = scene.data;
      authoritativeSnapshotScopeRef.current = authoringScopeKey;
      acknowledgedSceneRevisionRef.current = observedRevision;
    }
  }, [authoringScopeKey, scene.data, scene.status, sceneRevision]);
  const sceneHasPayload = sceneHasAuthoringPayload(scene.data);
  const sceneMagneticObjectCount = magneticObjectCount(scene.data);
  const sceneStageCount = rawStudyStages(scene.data).length;
  const studySignature = studyAuthoringSignature(scene.data);
  useEffect(() => {
    if (!scene.data) return;
    if (!sceneHasAuthoringPayload(scene.data)) return;
    const rawStages = rawStudyStages(scene.data);
    const source = readStudyStageSource(asRecord(scene.data)?.study);
    const stageDrafts = source.kind === "flat" ? createStudyStageDrafts(rawStages)
      : createPipelineStudyStageDrafts(source.entries);
    dispatch({
      type: "resetStageDrafts",
      drafts: stageDrafts,
      globalDraft: createStudyGlobalDraft(scene.data),
      preserveGlobalDraft:
        JSON.stringify(state.globalDraft) !== JSON.stringify(state.baselineGlobalDraft)
          ? state.globalDraft
          : undefined,
      preserveStageDrafts:
        JSON.stringify(state.stageDrafts) !== JSON.stringify(state.baselineStageDrafts)
          ? state.stageDrafts
          : undefined,
      revision: sceneRevision,
      selectedIndex:
        stageDrafts.length === 0
          ? 0
          : Math.min(selectedStageIndex, stageDrafts.length - 1),
      signature: studySignature,
    });
  }, [
    scene.data,
    sceneRevision,
    selectedStageIndex,
    state.baselineGlobalDraft,
    state.baselineStageDrafts,
    state.globalDraft,
    state.stageDrafts,
    studySignature,
  ]);
  const activeStageIndex = scopedStageExecutionData?.active_stage_index ?? null;
  const commandContext = createCommandContext("inspector", kernel, {
    resourceData: {
      ...buildRuntimeCommandControlResourceData({
        commandQueue: commandQueue.data,
        geometryValidation: geometryValidation.data,
        meshBuildCurrent: meshBuildCurrent.data,
        meshManifest: meshManifest.data,
        modelReadinessData: modelReadiness.data,
        modelReadinessStatus: modelReadiness.status,
        sessionStatus: runtimeStatus,
        solverStatus: solverStatus.data,
        stageExecution: scopedStageExecutionData,
      }),
      [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
      [MESHING_PERIODIC_PAIRS_PATH]: periodicPairs.data,
      [MESHING_SUMMARY_PATH]: meshSummary.data,
      [MODEL_SCENE_PATH]: scene.data,
      [PERSISTENCE_CHECKPOINTS_PATH]: checkpointCatalog.data,
      [SIMULATION_RUN_CURRENT_PATH]: currentRun.data,
    },
    sessionScopeKey,
    sourceDetail: "study",
  });
  const createAuthoringMutationContext = (
    sceneSnapshot: SceneResource | null = scene.data,
  ) => {
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    return {
      ...commandContext,
      resourceData: {
        ...commandContext.resourceData,
        [MODEL_SCENE_PATH]: sceneSnapshot,
      },
      isCurrentSessionScope: () =>
        commandContext.isCurrentSessionScope?.() !== false &&
        (historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration),
    };
  };
  const readAuthoritativeScene = async (): Promise<{
    revision: number;
    scene: SceneResource;
  } | null> => {
    const observedRevision = numericSceneRevision(sceneRevision);
    if (
      authoritativeSnapshotScopeRef.current === authoringScopeKey &&
      scene.data &&
      observedRevision !== null &&
      (acknowledgedSceneRevisionRef.current === null ||
        observedRevision >= acknowledgedSceneRevisionRef.current)
    ) {
      authoritativeSceneRef.current = scene.data;
      acknowledgedSceneRevisionRef.current = observedRevision;
      return { revision: observedRevision, scene: scene.data };
    }
    try {
      const canonical = await kernel.api.model.scene(
        sessionScopeKey ? { sessionScopeKey } : undefined,
      );
      if (commandContext.isCurrentSessionScope?.() === false) return null;
      const revision = numericSceneRevision(sceneRevisionValue(canonical));
      if (
        revision === null ||
        (acknowledgedSceneRevisionRef.current !== null &&
          revision < acknowledgedSceneRevisionRef.current)
      ) {
        return null;
      }
      authoritativeSceneRef.current = canonical;
      authoritativeSnapshotScopeRef.current = authoringScopeKey;
      acknowledgedSceneRevisionRef.current = revision;
      return { revision, scene: canonical };
    } catch {
      return null;
    }
  };
  const runCommand = (commandId: string, input?: unknown) => {
    void kernel.commands.execute(commandId, commandContext, input);
  };
  const inspectImportFile = async (file: File | null) => {
    const generation = ++importInspectionGeneration.current;
    const scopeAtSelection = sessionScopeKey;
    dispatch({
      type: "prepareImportFile",
      fileName: file?.name ?? null,
    });
    if (!file) return;

    try {
      const fmsBase64 = await readFileAsBase64(file);
      if (
        generation !== importInspectionGeneration.current ||
        scopeAtSelection !== importScopeRef.current
      ) return;
      const inspection = await kernel.api.persistence.imports.inspect({
        fms_base64: fmsBase64,
      });
      if (
        generation !== importInspectionGeneration.current ||
        scopeAtSelection !== importScopeRef.current
      ) return;
      dispatch({
        type: "importInspectSuccess",
        fmsBase64,
        inspection: inspection.inspection,
      });
    } catch (error) {
      if (
        generation !== importInspectionGeneration.current ||
        scopeAtSelection !== importScopeRef.current
      ) return;
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
  const buildStudyProgress = commands.isActive("study.build-and-run", commandContext)
    ? commandDisabledReason("study.build-and-run") ?? "An existing Build + Study is pending. Check it again to continue."
    : null;
  const commitStageDraftsImpl = async () => {
    const feedbackTargetAtSave = selectedAuthoringTargetKey;
    const launch = stageApplyRun.current;
    const submittedDrafts = state.stageDrafts;
    const textureEdits = submittedDrafts.filter((draft, index) =>
      JSON.stringify(draft.stageMagnetizationAssignments) !==
        JSON.stringify(state.baselineStageDrafts[index]?.stageMagnetizationAssignments),
    );
    const currentScene = await readAuthoritativeScene();
    const expectedRevision = launch?.pin.scene_revision ??
      (textureEdits.length > 0 ? numericSceneRevision(sceneRevision) : undefined);
    if (!currentScene || (expectedRevision !== undefined && currentScene.revision !== expectedRevision)) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "stages",
        feedback: {
          kind: "error",
          message: launch || textureEdits.length > 0
            ? "The Study changed before saving. Review the stage draft and try again."
            : "Could not read the current scene revision. Refresh the scene before saving stages.",
        },
      });
      return false;
    }
    const isCanonical = readStudyStageSource(asRecord(currentScene.scene)?.study).kind === "pipeline";
    const changed = isCanonical
      ? submittedDrafts.filter((draft, index) =>
          JSON.stringify(draft) !== JSON.stringify(state.baselineStageDrafts[index]),
        )
      : [];
    const pipelineDraft = changed.length === 1 ? changed[0] : null;
    if (isCanonical && !pipelineDraft) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "stages",
        feedback: { kind: "error", message: "Save one edited canonical Run or Relax stage at a time." },
      });
      return false;
    }
    if (
      !isCanonical && hasStudyExecutionProfile(currentScene.scene) &&
      hasChangeDeviceStudyStage(currentScene.scene, submittedDrafts)
    ) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "stages",
        feedback: {
          kind: "error",
          message:
            "A Change device stage cannot be saved while an execution profile is bound. Remove the stage or clear the profile first.",
        },
      });
      return false;
    }
    const localIssues = submittedDrafts.flatMap((draft, index) => {
      if (pipelineDraft && pipelineDraft !== draft) return [];
      return validateStudyStageDraft(draft, {
        activeLane: runtimeStatus?.capabilities.active_lane ?? null,
        algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
        backend: model.requested.backend,
        demagEnabled: state.globalDraft.demagEnabled,
        device: model.requested.device,
        ...k0ModalReadinessFor(draft),
        mode: model.requested.mode,
        precision: state.globalDraft.requestedPrecision,
      }).map((issue) => ({
        ...issue,
        message: `Stage ${index + 1}: ${issue.message}`,
      }));
    });
    const workflowIssues = validateStudyWorkflow(submittedDrafts)
      .filter((issue) => !pipelineDraft || submittedDrafts[issue.index] === pipelineDraft)
      .map((issue) => ({
        ...issue,
        message: `Stage ${issue.index + 1}: ${issue.message}`,
      }));
    const textureTargetsValid = textureEdits.every((draft) =>
      (readStageTextureAssignments(draft.stageMagnetizationAssignments) ?? []).every((assignment) => {
        const object = currentScene.scene.objects?.find((candidate) =>
          candidate.id === assignment.object_id && candidate.role === "magnet",
        );
        return object && (assignment.region_id === null ||
          object.regions?.some((region) => region.region_id === assignment.region_id));
      }),
    );
    const issues = [...localIssues, ...workflowIssues];
    if (!textureTargetsValid) issues.push({
      message: "A stage texture target is no longer present in the saved scene.",
      severity: "error",
    });
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
      return false;
    }

    const baseRevision = currentScene.revision;

    const mutationContext = createAuthoringMutationContext(currentScene.scene);
    dispatch({ type: "setAuthoringBusy", busy: true });
    try {
      const response = await runAuthoringMutationWithHistory(
        mutationContext,
        "Edit study stages",
        () => kernel.api.model.commitTransaction(
          pipelineDraft
            ? buildStudyPipelineStageMergePatch(pipelineDraft, baseRevision, currentScene.scene)
            : buildStudyStagesMergePatch(submittedDrafts, baseRevision, currentScene.scene),
          sessionScopeKey ? { sessionScopeKey } : undefined,
        ),
      );
      if (mutationContext.isCurrentSessionScope() === false) return false;
      const revision = response.scene_revision;
      const acknowledgedSource = pipelineDraft
        ? readStudyStageSource(asRecord(response.committed_scene)?.study)
        : null;
      const committedEntry = acknowledgedSource?.kind === "pipeline"
        ? acknowledgedSource.entries.find((entry) => entry.queueId === pipelineDraft?.pipelineNodeId)
        : undefined;
      const committedPipelineDraft = committedEntry && committedEntry.stageKind === pipelineDraft?.kind
        ? createPipelineStudyStageDrafts([committedEntry])[0]
        : undefined;
      if (pipelineDraft && (!committedPipelineDraft || response.committed_scene?.revision !== revision)) {
        scene.refetch();
        throw new Error("The save response did not confirm the edited canonical stage. Review the refreshed scene before retrying.");
      }
      acknowledgedSceneRevisionRef.current = revision;
      if (response.committed_scene?.revision === revision) {
        authoritativeSceneRef.current = response.committed_scene;
        authoritativeSnapshotScopeRef.current = authoringScopeKey;
      }
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_READINESS_PATH, revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
      kernel.resources.invalidate(SIMULATION_COMMANDS_PATH, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_RESULTS_PATH, revision);
      kernel.resources.invalidatePrefix?.(`${SIMULATION_STAGES_RESULTS_PATH}?`, revision);
      if (selectedAuthoringTargetRef.current === feedbackTargetAtSave) {
        dispatch({
          type: "setAuthoringFeedback",
          scope: "stages",
          feedback: {
            kind: "success",
            message: pipelineDraft
              ? `Saved stage ${pipelineDraft.stageId}.`
              : `Committed ${submittedDrafts.length} study stage${submittedDrafts.length === 1 ? "" : "s"}.`,
            sceneRevision: revision,
          },
        });
      }
      if (launch) {
        launch.receipt = response;
        // Make the submitted baseline visible to the shared guard before the
        // explicit Apply-and-Run gesture continues. Newer edits remain dirty.
        flushSync(() => {
          dispatch({ type: "acceptStageDrafts", submittedDrafts, committedPipelineDraft });
          dispatch({ type: "setAuthoringBusy", busy: false });
        });
      } else {
        dispatch({ type: "acceptStageDrafts", submittedDrafts, committedPipelineDraft });
      }
      return true;
    } catch (error) {
      if (mutationContext.isCurrentSessionScope() === false) return false;
      if (
        error instanceof ControlRoomApiError &&
        (error.status === 409 ||
          error.code === "revision_conflict" ||
          error.code === "scene_revision_conflict")
      ) {
        scene.refetch();
        dispatch({
          type: "setAuthoringFeedback",
          scope: "stages",
          feedback: {
            kind: "error",
            message:
              "Scene revision conflict. Refetched the canonical scene; the stage draft was preserved for review and retry.",
          },
        });
      } else {
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
      }
      return false;
    } finally {
      dispatch({ type: "setAuthoringBusy", busy: false });
    }
  };
  const commitGlobalDraftImpl = async () => {
    const currentScene = await readAuthoritativeScene();
    if (currentScene === null) {
      dispatch({
        type: "setAuthoringFeedback",
        scope: "global",
        feedback: {
          kind: "error",
          message:
            "The canonical scene revision is unavailable. Refetch before applying the grid.",
        },
      });
      return false;
    }
    const baseRevision = currentScene.revision;
    const profileBound = hasStudyExecutionProfile(currentScene.scene);
    const errors = validateStudyGlobalDraft(state.globalDraft, {
      studyStages: rawStudyStages(currentScene.scene),
      activeLane: runtimeStatus?.capabilities.active_lane ?? null,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      executionProfileBound: profileBound,
      magneticObjectCount: magneticObjectCount(currentScene.scene),
      magneticObjectIds: magneticObjectIds(currentScene.scene),
      sessionDiscretization: resolveSessionDiscretization(runtimeStatus),
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
      return false;
    }

    const mutationContext = createAuthoringMutationContext(currentScene.scene);
    dispatch({ type: "setAuthoringBusy", busy: true });
    try {
      const response = await runAuthoringMutationWithHistory(
        mutationContext,
        "Edit global study settings",
        () => kernel.api.model.commitTransaction(
          buildStudyGlobalMergePatch(state.globalDraft, {
            baseRevision,
            baselineDraft: state.baselineGlobalDraft,
            executionProfileBound: profileBound,
            sessionDiscretization: resolveSessionDiscretization(runtimeStatus),
          }),
          sessionScopeKey ? { sessionScopeKey } : undefined,
        ),
      );
      if (mutationContext.isCurrentSessionScope() === false) return false;
      const revision = response.scene_revision;
      acknowledgedSceneRevisionRef.current = revision;
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_READINESS_PATH, revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
      kernel.resources.invalidate(SIMULATION_COMMANDS_PATH, revision);
      const explicitFdm = isExplicitFdmStudy({
        requestedBackend: profileBound
          ? null
          : state.globalDraft.requestedBackend,
        sessionDiscretization: resolveSessionDiscretization(runtimeStatus),
      });
      if (explicitFdm) {
        invalidateFdmGridResources(kernel.resources, revision);
      }
      let feedbackKind: "success" | "warning" | "error" = "success";
      let feedbackMessage = "Committed global study settings.";
      if (explicitFdm) {
        try {
          const result = await runFdmGridRefreshOperation(commandContext, {
            kind: "fdm_grid_refresh",
            reason: "study_global_commit",
            precondition: { scene_revision: revision },
          });
          if (result.status === "completed") {
            feedbackMessage = "Committed global study settings. FDM grid replan completed; magnetization was reinitialized from the model.";
          } else if (result.status === "failed") {
            feedbackKind = "error";
            feedbackMessage =
              result.message ??
              "Global study settings were saved, but the FDM grid replan failed.";
          } else {
            feedbackKind = "warning";
            feedbackMessage =
              result.message ??
              "Global study settings were saved. FDM grid replan remains active; see Mesh Jobs.";
          }
        } catch (error) {
          feedbackKind = "warning";
          feedbackMessage = `Global study settings were saved, but the FDM grid replan could not be submitted: ${
            error instanceof Error ? error.message : "unknown command error"
          }`;
        }
      }
      if (mutationContext.isCurrentSessionScope() === false) return false;
      dispatch({
        type: "setAuthoringFeedback",
        scope: "global",
        feedback: {
          kind: feedbackKind,
          message: feedbackMessage,
        },
      });
      dispatch({ type: "acceptGlobalDraft" });
      return true;
    } catch (error) {
      if (mutationContext.isCurrentSessionScope() === false) return false;
      if (
        error instanceof ControlRoomApiError &&
        (error.status === 409 ||
          error.code === "revision_conflict" ||
          error.code === "scene_revision_conflict")
      ) {
        scene.refetch();
        dispatch({
          type: "setAuthoringFeedback",
          scope: "global",
          feedback: {
            kind: "error",
            message:
              "Scene revision conflict. Refetched the canonical scene; the grid draft was preserved for review and retry.",
          },
        });
      } else {
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
      }
      return false;
    } finally {
      dispatch({ type: "setAuthoringBusy", busy: false });
    }
  };

  const commitExecutionProfileImpl = async (
    assignment: StudyExecutionProfileAssignment,
    baseRevision: number,
  ) => {
    if (state.authoringBusy) {
      return {
        success: false,
        message: "Another Study authoring transaction is still in progress.",
      };
    }
    const currentScene = await readAuthoritativeScene();
    if (!currentScene) {
      return {
        success: false,
        message: "Could not read the current scene. The profile draft was preserved.",
      };
    }
    if (currentScene.revision !== baseRevision) {
      return {
        stale: true,
        success: false,
        message:
          "The scene revision changed while this draft was open. The draft was preserved; cancel to load the current scene.",
      };
    }
    if (
      assignment.execution_profile !== null &&
      hasChangeDeviceStudyStage(currentScene.scene, [
        ...rawStudyStages(currentScene.scene),
        ...state.stageDrafts,
      ])
    ) {
      return {
        success: false,
        message:
          "A Change device stage cannot be combined with an execution profile. Remove the stage and save that change first, or clear the profile.",
      };
    }

    const mutationContext = createAuthoringMutationContext(currentScene.scene);
    dispatch({ type: "setAuthoringBusy", busy: true });
    try {
      const response = await runAuthoringMutationWithHistory(
        mutationContext,
        "Assign Study execution profile",
        () => kernel.api.model.commitTransaction(
          buildStudyExecutionProfileAssignmentMergePatch(
            assignment,
            baseRevision,
          ),
          sessionScopeKey ? { sessionScopeKey } : undefined,
        ),
      );
      if (mutationContext.isCurrentSessionScope() === false) {
        return {
          success: false,
          message: "The active session changed. The profile draft was preserved.",
        };
      }
      const revision = response.scene_revision;
      acknowledgedSceneRevisionRef.current = revision;
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_READINESS_PATH, revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
      kernel.resources.invalidate(SIMULATION_COMMANDS_PATH, revision);
      return { revision, success: true };
    } catch (error) {
      if (mutationContext.isCurrentSessionScope() === false) {
        return {
          success: false,
          message: "The active session changed. The profile draft was preserved.",
        };
      }
      if (
        error instanceof ControlRoomApiError &&
        (error.status === 409 ||
          error.code === "revision_conflict" ||
          error.code === "scene_revision_conflict")
      ) {
        scene.refetch();
        return {
          stale: true,
          success: false,
          message:
            "Scene revision conflict. The canonical scene was refreshed; this profile draft was preserved for review and retry.",
        };
      }
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to assign the Study execution profile. The draft was preserved.",
      };
    } finally {
      dispatch({ type: "setAuthoringBusy", busy: false });
    }
  };

  // Keep the existing revision-fenced transactions available until the
  // retained draft owner is integrated with all of its supporting modules.
  const owner = {
    commitStageDrafts: commitStageDraftsImpl,
    commitGlobalDraft: commitGlobalDraftImpl,
    commitExecutionProfile: commitExecutionProfileImpl,
  };
  const commitStageDrafts = async () => {
    if (stageSaveInFlight.current) return false;
    stageSaveInFlight.current = true;
    try {
      return await owner.commitStageDrafts();
    } finally {
      stageSaveInFlight.current = false;
    }
  };

  const stageRunDisabledReason = (
    stageId: string,
    applyDraft: boolean,
    form: InspectorEditSession | null,
  ): string | null => {
    if (stageApplyRun.current || stageSaveInFlight.current || state.authoringBusy) {
      return "Wait for the stage save to finish.";
    }
    if (!applyDraft) {
      const context = { ...commandContext, input: { stageId } };
      return commands.isEnabled("study.execute-stage", context)
        ? null
        : commands.get("study.execute-stage")?.disabledReason?.(context) ?? "Stage execution is unavailable.";
    }

    const selectedCount = state.stageDrafts.filter((draft) => draft.stageId === stageId).length;
    const baselineCount = state.baselineStageDrafts.filter((draft) => draft.stageId === stageId).length;
    if (selectedCount !== 1 || baselineCount !== 1) {
      return "Save the Study first so the selected stage has a unique committed ID.";
    }
    const otherDraftsChanged = state.stageDrafts.length !== state.baselineStageDrafts.length ||
      state.stageDrafts.some((draft, index) => {
        const baseline = state.baselineStageDrafts[index];
        return (draft.stageId !== stageId || baseline.stageId !== stageId) &&
          JSON.stringify(draft) !== JSON.stringify(baseline);
      });
    if (otherDraftsChanged) return "Apply or discard changes to other Study stages first.";
    const geometryReason = studyComputeDraftBlockedReason({ ...commandContext, pendingForms: undefined });
    if (geometryReason) return geometryReason;

    const forms = kernel.pendingForms;
    const pending = forms?.getTransitionSnapshot();
    if (!form || !forms || !pending || forms.current() !== form || !form.dirty) {
      return "Wait for the stage draft to be available.";
    }
    if (pending.dirtyOwnerCount !== 1) return "Apply or discard the other Inspector changes first.";
    if (!forms.canApply()) {
      return pending.blockedReason ?? "Resolve stage draft validation errors before applying.";
    }
    if (!runtimeStatus || numericSceneRevision(sceneRevision) !== runtimeStatus.resources.scene_revision) {
      return "Wait for the displayed Study to refresh before saving and starting.";
    }
    return null;
  };

  const runStage = async (
    stageId: string,
    applyDraft: boolean,
    form: InspectorEditSession | null,
    initialState?: StageInitialStateChoice,
  ): Promise<CommandResult> => {
    const reason = stageRunDisabledReason(stageId, applyDraft, form);
    if (reason) return { message: reason, status: "failed" };
    if (!applyDraft) {
      return commands.execute("study.execute-stage", commandContext, {
        stageId,
        initialState: initialState ?? { kind: "default_for_target" },
      });
    }

    if (initialState?.kind === "prepared") {
      return { message: "Save the stage first, then choose a prepared magnetization for the saved scene.", status: "failed" };
    }
    const baseRevision = numericSceneRevision(sceneRevision);
    const forms = kernel.pendingForms;
    if (!forms || !runtimeStatus || baseRevision === null) {
      return { message: "The stage draft has no committed Study revision.", status: "failed" };
    }
    const launch = {
      pin: {
        ...captureStudyComputeInput(runtimeStatus),
        scene_revision: baseRevision,
      },
      receipt: null as AuthoringTransactionResponse | null,
    };
    stageApplyRun.current = launch;
    let scopeCurrent = true;
    const unsubscribe = commands.subscribeSessionScope(() => {
      if (commandContext.isCurrentSessionScope?.() === false) scopeCurrent = false;
    });
    try {
      return await executeStageAfterApply({
        api: kernel.api,
        apply: async () => {
          const result = await forms.apply();
          return result.status === "completed" ? launch.receipt : null;
        },
        execute: (input, resources) => commands.execute("study.execute-stage", {
          ...commandContext,
          resourceData: { ...commandContext.resourceData, ...resources },
        }, input),
        isCurrent: () => scopeCurrent &&
          commandContext.isCurrentSessionScope?.() !== false &&
          kernel.selection.get().nodeId === selection.nodeId &&
          forms.current() === form,
        initialState,
        pin: launch.pin,
        requestOptions: sessionScopeKey ? { sessionScopeKey } : undefined,
        stageId,
      });
    } finally {
      unsubscribe();
      stageApplyRun.current = null;
    }
  };
  const commitGlobalDraft = owner.commitGlobalDraft;
  const commitExecutionProfile = owner.commitExecutionProfile;
  return {
    activeStageIndex,
    buildStudyProgress,
    checkpointCatalog,
    checkpoints,
    commandDetail,
    commandDisabledReason,
    commitGlobalDraft,
    commitExecutionProfile,
    commitStageDrafts,
    currentRun,
    dispatch,
    energyCurrent,
    energyHistory,
    inspectImportFile,
    latestCheckpoint,
    k0ModalReadinessFor,
    model,
    modelReadiness,
    runtimeStatus,
    runCommand,
    runStage,
    stageRunDisabledReason,
    scene,
    sceneHasPayload,
    sceneMagneticObjectCount,
    sceneRevision,
    sceneStageCount,
    sessionScopeKey,
    selectedRestoreCheckpoint,
    snapshot,
    solverStatus,
    stageExecution: scopedStageExecution,
    state,
  };
}

export type StudyInspectorSectionScope =
  | "all"
  | "overview"
  | "stages"
  | "execution"
  | "recovery";

export function StudyInspectorPanel({
  selection,
  sectionScope = "all",
}: InspectorPanelProps & {
  sectionScope?: StudyInspectorSectionScope;
}) {
  const {
    buildStudyProgress,
    activeStageIndex,
    checkpointCatalog,
    checkpoints,
    commandDetail,
    commandDisabledReason,
    commitGlobalDraft,
    commitExecutionProfile,
    commitStageDrafts,
    currentRun,
    dispatch,
    energyCurrent,
    energyHistory,
    inspectImportFile,
    latestCheckpoint,
    k0ModalReadinessFor,
    model,
    runtimeStatus,
    runCommand,
    scene,
    sceneHasPayload,
    sceneMagneticObjectCount,
    sceneRevision,
    sceneStageCount,
    sessionScopeKey,
    selectedRestoreCheckpoint,
    snapshot,
    solverStatus,
    stageExecution,
    state,
  } = useStudyInspectorPanelController(selection);
  const profileEditSessionRef = useRef<StudyExecutionProfileEditSession | null>(null);
  const [profileEditState, setProfileEditState] = useState({
    dirty: false,
    profileBound: false,
    valid: true,
  });
  const onProfileEditSessionChange = useCallback(
    (session: StudyExecutionProfileEditSession | null) => {
      profileEditSessionRef.current = session;
      const next = session
        ? {
            dirty: session.dirty,
            profileBound: session.profileBound,
            valid: session.valid,
          }
        : { dirty: false, profileBound: false, valid: true };
      setProfileEditState((current) =>
        current.dirty === next.dirty &&
        current.profileBound === next.profileBound &&
        current.valid === next.valid
          ? current
          : next,
      );
    },
    [],
  );
  const sceneMagneticObjectIds = magneticObjectIds(scene.data);
  const globalValidation = validateStudyGlobalDraft(state.globalDraft, {
    studyStages: rawStudyStages(scene.data),
    studyStageDrafts: state.stageDrafts,
    activeLane: runtimeStatus?.capabilities.active_lane ?? null,
    algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
    executionProfileBound:
      hasStudyExecutionProfile(scene.data) || profileEditState.profileBound,
    magneticObjectCount: sceneMagneticObjectCount,
    magneticObjectIds: sceneMagneticObjectIds,
    sessionDiscretization: resolveSessionDiscretization(runtimeStatus),
  });
  const workflowValidation = validateStudyWorkflow(state.stageDrafts);
  const stageValidation = state.stageDrafts.flatMap((draft, index) => [
    ...validateStudyStageDraft(draft, {
      activeLane: runtimeStatus?.capabilities.active_lane ?? null,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: model.requested.backend,
      demagEnabled: state.globalDraft.demagEnabled,
      device: model.requested.device,
      mode: model.requested.mode,
      precision: state.globalDraft.requestedPrecision,
    }),
    ...workflowValidation.flatMap(({ index: issueIndex, message, severity }) =>
      issueIndex === index ? [{ message, severity }] : [],
    ),
  ]);
  const globalDirty =
    JSON.stringify(state.globalDraft) !== JSON.stringify(state.baselineGlobalDraft);
  const stagesDirty =
    JSON.stringify(state.stageDrafts) !== JSON.stringify(state.baselineStageDrafts);
  const applyInspectorDraft = useCallback(async () => {
    if (profileEditState.dirty) {
      if (globalDirty || stagesDirty) return false;
      return (await profileEditSessionRef.current?.apply()) === true;
    }
    return applyStudyDraftsWithPartialFailure({
      globalDirty,
      stagesDirty,
      commitGlobal: commitGlobalDraft,
      commitStages: commitStageDrafts,
    });
  }, [commitGlobalDraft, commitStageDrafts, globalDirty, profileEditState.dirty, stagesDirty]);
  const resetInspectorDraft = useCallback(() => {
    dispatch({ type: "revertGlobalDraft" });
    dispatch({ type: "revertStageDrafts" });
    profileEditSessionRef.current?.reset();
  }, [dispatch]);
  useRegisterInspectorEditSession(
    "staged",
    state.authoringBusy,
    globalDirty || stagesDirty || profileEditState.dirty,
    ![...globalValidation, ...stageValidation].some(
      (issue) => issue.severity === "error",
    ) && profileEditState.valid,
    state.authoringBusy ? "Study changes are being saved." : undefined,
    applyInspectorDraft,
    resetInspectorDraft,
    {
      applyBlockReason: profileEditState.dirty && (globalDirty || stagesDirty)
        ? "Apply or cancel the execution profile first, then save the other Study edits."
        : undefined,
      historyMode: "mutation-owned",
    },
  );

  const showRuntime =
    sectionScope === "all" ||
    sectionScope === "overview" ||
    sectionScope === "execution";
  const showRunsAndBatches =
    sectionScope === "all" || sectionScope === "execution";
  const showSelectedStage =
    sectionScope === "all" || sectionScope === "stages";
  const showBoundaryAndProfile =
    sectionScope === "all" ||
    sectionScope === "overview" ||
    sectionScope === "execution";
  const showPipeline =
    sectionScope === "all" ||
    sectionScope === "overview" ||
    sectionScope === "stages";
  const showRecovery =
    sectionScope === "all" || sectionScope === "recovery";
  const showHistory =
    sectionScope === "all" ||
    sectionScope === "execution" ||
    sectionScope === "recovery";
  const resolvedDiscretization =
    resolveSessionDiscretization(runtimeStatus) ??
    snapshot.requested.backend ??
    "auto";

  return (
    <>
      <div
        className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
        data-scene-has-payload={sceneHasPayload}
        data-scene-revision={sceneRevision ?? ""}
        data-scene-stage-count={sceneStageCount}
        data-scene-status={scene.status}
        data-stage-draft-count={state.stageDrafts.length}
      >
        <InspectorMetricStrip
          metrics={[
            {
              label: "Workflow",
              value:
                model.selectedStage?.kind ??
                state.stageDrafts[0]?.kind ??
                "authoring",
            },
            {
              label: "Discretization",
              value: resolvedDiscretization.toUpperCase(),
            },
            {
              label: "Stages",
              value: String(state.stageDrafts.length),
            },
            {
              label: "State",
              value: model.runtime.state,
            },
          ]}
        />

        {showRuntime ? (
          <StudyRuntimeSection
            buildStudyProgress={buildStudyProgress}
            commandDisabledReason={commandDisabledReason}
            model={model}
            onOpenCommand={(commandId) =>
              dispatch({ type: "setSelectedCommandId", commandId })
            }
            runCommand={runCommand}
            stageExecution={stageExecution}
            stepValue={
              solverStatus.data?.step_index ?? currentRun.data?.total_steps ?? "n/a"
            }
          />
        ) : null}

        {showRunsAndBatches ? (
          <>
            <ProjectRunsSection />
            <ProjectBatchesSection />
          </>
        ) : null}

        {showSelectedStage ? (
          <StudySelectedStageSection
            model={model}
            stageExecutionRevision={stageExecution.data?.revision ?? null}
          />
        ) : null}

        {showBoundaryAndProfile ? (
          <>
            <StudyBoundarySection
              activeLane={runtimeStatus?.capabilities.active_lane ?? null}
              algorithmsAvailable={runtimeStatus?.capabilities.algorithms_available}
              authoringBusy={state.authoringBusy}
              authoringFeedback={
                state.authoringFeedbackScope === "global"
                  ? state.authoringFeedback
                  : null
              }
              draft={state.globalDraft}
              executionProfileBound={
                hasStudyExecutionProfile(scene.data) || profileEditState.profileBound
              }
              executionProfileDraftDirty={profileEditState.dirty}
              model={model}
              magneticObjectCount={sceneMagneticObjectCount}
              magneticObjectIds={sceneMagneticObjectIds}
              scene={scene.data}
              sceneRevision={sceneRevision}
              sceneStatus={scene.status}
              sessionDiscretization={resolveSessionDiscretization(runtimeStatus)}
              snapshot={snapshot}
              onCommit={() => void commitGlobalDraft()}
              onUpdate={(patch) =>
                dispatch({ type: "updateGlobalDraft", patch })
              }
            />

            <StudyExecutionProfileSection
              authoringBusy={state.authoringBusy}
              otherAuthoringDirty={globalDirty || stagesDirty}
              scene={scene.data}
              sceneRevision={sceneRevision}
              sceneStatus={scene.status}
              sessionScopeKey={sessionScopeKey}
              stages={[...rawStudyStages(scene.data), ...state.stageDrafts]}
              onApply={commitExecutionProfile}
              onEditSessionChange={onProfileEditSessionChange}
            />
          </>
        ) : null}

        {showPipeline ? (
          <StudyPipelineSection
            readOnlyReason={readStudyStageSource(asRecord(scene.data)?.study).kind !== "flat"
              ? readStudyStageSource(asRecord(scene.data)?.study).error ?? "Canonical pipeline inspection is read-only. Flat-stage editing cannot preserve its groups and references."
              : null}
            activeStageIndex={activeStageIndex}
            activeLane={runtimeStatus?.capabilities.active_lane ?? null}
            algorithmsAvailable={runtimeStatus?.capabilities.algorithms_available}
            authoringBusy={state.authoringBusy}
            authoringFeedback={
              state.authoringFeedbackScope === "stages"
                ? state.authoringFeedback
                : null
            }
            commandDisabledReason={commandDisabledReason}
            demagEnabled={state.globalDraft.demagEnabled}
            executionProfileBound={
              hasStudyExecutionProfile(scene.data) || profileEditState.profileBound
            }
            executionProfileDraftDirty={profileEditState.dirty}
            k0ModalReadinessFor={k0ModalReadinessFor}
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
            showDraftEditor={state.stageDrafts.length === 0 || stagesDirty}
          />
        ) : null}

        {showRecovery ? (
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
        ) : null}

        {showHistory ? (
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
        ) : null}
      </div>
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
