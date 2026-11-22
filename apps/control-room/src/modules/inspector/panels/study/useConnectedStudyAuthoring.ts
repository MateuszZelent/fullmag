"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import {
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
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
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  SIMULATION_STAGES_RESULTS_PATH,
} from "@/kernel/api/apiPaths";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type {
  AuthoringTransactionRequest,
  CheckpointListResource,
  FrequencyDomainManifestResource,
  JsonValue,
  MeshPeriodicPairsResource,
  MeshSharedDomainManifestResource,
  SceneResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { runFdmGridRefreshOperation } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  invalidateFdmGridResources,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  shouldLoadRuntimeCurrentRun,
  shouldLoadRuntimeStageExecution,
  useCheckpointCatalogResource,
  useCommandQueueResource,
  useCurrentRunResource,
  useSolverEnergyCurrentResource,
  useSolverEnergyHistoryResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

import {
  buildStudyExecutionProfileAssignmentMergePatch,
  hasChangeDeviceStudyStage,
  hasStudyExecutionProfile,
  type StudyExecutionProfileAssignment,
} from "../StudyExecutionProfileModel";
import {
  buildStudyGlobalMergePatch,
  createStudyGlobalDraft,
  isExplicitFdmStudy,
  validateStudyGlobalDraft,
  type StudyGlobalDraft,
} from "../StudyGlobalAuthoringModel";
import { deriveK0ModalExecutionReadiness } from "../StudyInspectorPanel.model";
import {
  resolveStudyInspectorModel,
  stageExecutionForCurrentScope,
  studySnapshotFromScene,
} from "../StudyInspectorPanelModel";
import {
  buildStudyPipelineStageMergePatch,
  buildStudyStagesMergePatch,
  createDefaultStudyStageDraft,
  createStudyStageDrafts,
  validateStudyStageDraft,
  type K0ModalExecutionReadiness,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "../StudyStageAuthoringModel";
import {
  magneticObjectCount,
  magneticObjectIds,
  rawStudyStages,
} from "../studyInspectorShared";
import { createPipelineStudyStageDrafts } from "../studyPipelineStageDrafts";
import { validateStudyWorkflow } from "../stages/studyWorkflowState";
import type { PipelineStripStep } from "./ConnectedInspectorSpec";

const RUNTIME_PEEK_PATHS = [
  MODEL_READINESS_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_SUMMARY_PATH,
] as const;

export function buildStudyCommandContext(
  kernel: KernelApi,
  options?: {
    extraResourceData?: Record<string, unknown>;
    runtimeStatus?: unknown;
    sceneData?: unknown;
    sessionScopeKey?: string | null;
    sourceDetail?: string;
  },
) {
  const peekFn = (
    kernel.resources as unknown as
      | { peek?: (key: string) => { data?: unknown } | undefined }
      | undefined
  )?.peek;
  const resourceData: Record<string, unknown> = {};
  if (typeof peekFn === "function") {
    for (const key of RUNTIME_PEEK_PATHS) {
      const peeked = peekFn.call(kernel.resources, key);
      if (peeked && peeked.data !== undefined) {
        resourceData[key] = peeked.data;
      }
    }
    const peekedScene = peekFn.call(kernel.resources, MODEL_SCENE_PATH);
    if (peekedScene && peekedScene.data !== undefined) {
      resourceData[MODEL_SCENE_PATH] = peekedScene.data;
    }
    const peekedSession = peekFn.call(
      kernel.resources,
      SESSION_STATUS_RESOURCE_KEY,
    );
    if (peekedSession && peekedSession.data !== undefined) {
      resourceData[SESSION_STATUS_RESOURCE_KEY] = peekedSession.data;
    }
  }
  if (options?.sceneData !== undefined) {
    resourceData[MODEL_SCENE_PATH] = options.sceneData;
  }
  if (options?.runtimeStatus !== undefined) {
    resourceData[SESSION_STATUS_RESOURCE_KEY] = options.runtimeStatus;
  }
  if (options?.extraResourceData) {
    Object.assign(resourceData, options.extraResourceData);
  }
  return createCommandContext("inspector", kernel, {
    resourceData,
    sessionScopeKey: options?.sessionScopeKey ?? undefined,
    sourceDetail: options?.sourceDetail ?? "study",
  });
}

export function buildPipelineStripStepsFromDrafts(
  drafts: readonly StudyStageDraft[],
): PipelineStripStep[] {
  return drafts.map((d, idx) => {
    const stageId = d.stageId || `${d.kind}_${idx + 1}`;
    const routeKind =
      d.kind === "unsupported" ? "study.stage.action" : `study.stage.${d.kind}`;
    return {
      id: stageId,
      index: idx,
      kind: routeKind,
      label: d.kind.replace(/_/g, " "),
      status: d.stageEnabled === false ? "stale" : "ready",
      selection: {
        kind: routeKind,
        label: `${d.kind.replace(/_/g, " ")} ${idx + 1}`,
        nodeId: `model:study:stages:stage:${stageId}`,
        objectId: null,
        ref: {
          kind: "study.stage.action",
          nodeId: `model:study:stages:stage:${stageId}`,
          stageId,
          stageIndex: idx,
          type: "study-stage",
        },
      },
    };
  });
}

function readNumericSceneRevision(scene: unknown): number | null {
  if (!scene || typeof scene !== "object") return null;
  const record = scene as Record<string, unknown>;
  for (const key of ["revision", "scene_revision"] as const) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function extractStudyStageDraftsFromScene(
  scene: SceneResource | null | undefined,
): StudyStageDraft[] {
  const study =
    scene && typeof scene === "object" && "study" in scene
      ? (scene as { study?: unknown }).study
      : undefined;
  const source = readStudyStageSource(study);
  if (source.kind === "pipeline") {
    return createPipelineStudyStageDrafts(source.entries);
  }
  const rawStages =
    study &&
    typeof study === "object" &&
    "stages" in study &&
    Array.isArray((study as { stages?: unknown }).stages)
      ? (study as { stages: readonly unknown[] }).stages
      : [];
  return createStudyStageDrafts(rawStages);
}

export function matchSelectedStageDraft(
  drafts: readonly StudyStageDraft[],
  selection: Selection,
): { draft: StudyStageDraft | null; index: number } {
  const ref = selection.ref?.type === "study-stage" ? selection.ref : null;
  if (ref?.stageId) {
    const byId = drafts.findIndex(
      (candidate) =>
        candidate.pipelineNodeId === ref.stageId ||
        candidate.stageId === ref.stageId,
    );
    if (byId >= 0) {
      return { draft: drafts[byId] ?? null, index: byId };
    }
  }
  if (
    ref &&
    typeof ref.stageIndex === "number" &&
    ref.stageIndex >= 0 &&
    ref.stageIndex < drafts.length
  ) {
    return { draft: drafts[ref.stageIndex] ?? null, index: ref.stageIndex };
  }
  return {
    draft: drafts[0] ?? null,
    index: ref && typeof ref.stageIndex === "number" ? ref.stageIndex : 0,
  };
}

export function useKernelStudyAuthoring(selection: Selection) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const runtimeStatus = useSessionStatusSelector((state) => state.data);
  const [lastAuthoringError, setLastAuthoringError] = useState<string | null>(
    null,
  );
  const latestCommittedSceneRef = useRef<SceneResource | null>(null);
  const sessionDiscretization = useMemo(
    () => resolveSessionDiscretization(runtimeStatus),
    [runtimeStatus],
  );
  const requestedDiscretization =
    runtimeStatus?.capabilities?.active_lane?.requested?.discretization ?? null;

  const globalDraft = useMemo(
    () => createStudyGlobalDraft(scene.data),
    [scene.data],
  );
  const stageSource = useMemo(
    () => readStudyStageSource(scene.data?.study),
    [scene.data?.study],
  );
  const stageDrafts = useMemo(
    () => extractStudyStageDraftsFromScene(scene.data),
    [scene.data],
  );
  const pipelineStripSteps = useMemo(
    () => buildPipelineStripStepsFromDrafts(stageDrafts),
    [stageDrafts],
  );
  const { draft: selectedStageDraft, index: selectedStageIndex } = useMemo(
    () => matchSelectedStageDraft(stageDrafts, selection),
    [selection, stageDrafts],
  );

  const resolveAuthoritativeScene = useCallback(async (): Promise<{
    revision: number;
    scene: SceneResource | null;
  } | null> => {
    const cachedRevision = readNumericSceneRevision(scene.data);
    if (scene.data && cachedRevision !== null) {
      return { revision: cachedRevision, scene: scene.data };
    }
    if (typeof kernel.api?.model?.scene === "function") {
      const fetched = await kernel.api.model.scene(
        sessionScopeKey ? { sessionScopeKey } : undefined,
      );
      const fetchedRevision = readNumericSceneRevision(fetched);
      if (fetchedRevision !== null) {
        return { revision: fetchedRevision, scene: fetched };
      }
    }
    return null;
  }, [kernel.api, scene.data, sessionScopeKey]);

  const invalidateStudyResources = useCallback(
    (revision: number) => {
      if (!kernel.resources?.invalidate) return;
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_READINESS_PATH, revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
      kernel.resources.invalidate(SIMULATION_COMMANDS_PATH, revision);
      kernel.resources.invalidate(SIMULATION_STAGES_RESULTS_PATH, revision);
      kernel.resources.invalidatePrefix?.(
        `${SIMULATION_STAGES_RESULTS_PATH}?`,
        revision,
      );
    },
    [kernel.resources],
  );

  const submitTransaction = useCallback(
    async (
      label: string,
      sceneSnapshot: SceneResource | null,
      request: AuthoringTransactionRequest,
      options?: { refreshFdmGrid?: boolean },
    ): Promise<boolean> => {
      if (typeof kernel.api?.model?.commitTransaction !== "function") {
        return false;
      }
      setLastAuthoringError(null);
      const writeOpts = sessionScopeKey ? { sessionScopeKey } : undefined;
      try {
        const commandContext = buildStudyCommandContext(kernel, {
          runtimeStatus,
          sceneData: sceneSnapshot,
          sessionScopeKey,
          sourceDetail: "study",
        });
        const response = kernel.authoringHistory
          ? await runAuthoringMutationWithHistory(commandContext, label, () =>
              kernel.api.model.commitTransaction(request, writeOpts),
            )
          : await kernel.api.model.commitTransaction(request, writeOpts);
        if (
          response.committed_scene &&
          typeof response.committed_scene === "object"
        ) {
          const baseScene = sceneSnapshot ?? scene.data ?? null;
          latestCommittedSceneRef.current =
            "study" in response.committed_scene || !baseScene
              ? response.committed_scene
              : ({
                  ...baseScene,
                  ...response.committed_scene,
                } as SceneResource);
        }
        invalidateStudyResources(response.scene_revision);
        if (
          options?.refreshFdmGrid &&
          typeof kernel.resources?.invalidate === "function"
        ) {
          invalidateFdmGridResources(kernel.resources, response.scene_revision);
          try {
            await runFdmGridRefreshOperation(commandContext, {
              kind: "fdm_grid_refresh",
              precondition: { scene_revision: response.scene_revision },
              reason: "study-authoring",
            });
          } catch {
            // Grid refresh telemetry errors surface via runtime diagnostics
          }
        }
        return true;
      } catch (error) {
        if (
          error instanceof ControlRoomApiError &&
          (error.status === 409 ||
            error.code === "revision_conflict" ||
            error.code === "scene_revision_conflict")
        ) {
          scene.refetch?.();
          setLastAuthoringError(
            "Scene revision changed concurrently. Reloaded the latest scene — review and apply again.",
          );
          return false;
        }
        setLastAuthoringError(
          error instanceof Error ? error.message : "Could not save study changes.",
        );
        return false;
      }
    },
    [invalidateStudyResources, kernel, runtimeStatus, scene, sessionScopeKey],
  );

  const resolveK0Readiness = useCallback(
    async (draft: StudyStageDraft): Promise<K0ModalExecutionReadiness> => {
      const peekFn = (
        kernel.resources as unknown as
          | { peek?: (key: string) => { data?: unknown } | undefined }
          | undefined
      )?.peek;
      const peekResource = <T,>(key: string): T | null => {
        if (typeof peekFn !== "function") return null;
        const entry = peekFn.call(kernel.resources, key);
        return (entry?.data as T | null | undefined) ?? null;
      };

      let checkpointList = peekResource<CheckpointListResource>(
        PERSISTENCE_CHECKPOINTS_PATH,
      );
      let frequencyManifest = peekResource<FrequencyDomainManifestResource>(
        ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      );
      let meshManifest = peekResource<MeshSharedDomainManifestResource>(
        MESHING_SHARED_DOMAIN_MANIFEST_PATH,
      );
      let periodicPairs = peekResource<MeshPeriodicPairsResource>(
        MESHING_PERIODIC_PAIRS_PATH,
      );
      let solverStatus = peekResource<SolverStatusResource>(
        SIMULATION_SOLVER_STATUS_PATH,
      );
      let stageExecution = peekResource<StageExecutionResource>(
        SIMULATION_STAGES_EXECUTION_PATH,
      );

      if (
        draft.kind === "eigenmodes" &&
        draft.magnetostaticBc === "periodic_airbox_k0"
      ) {
        const reqOpts = sessionScopeKey ? { sessionScopeKey } : undefined;
        const [
          fetchedCkpts,
          fetchedFreq,
          fetchedMesh,
          fetchedPairs,
          fetchedSolver,
          fetchedExec,
        ] = await Promise.all([
          checkpointList === null &&
          typeof kernel.api?.persistence?.checkpoints?.list === "function"
            ? kernel.api.persistence.checkpoints.list(reqOpts).catch(() => null)
            : Promise.resolve(null),
          frequencyManifest === null &&
          typeof kernel.api?.analysis?.frequencyDomain?.manifestV1 === "function"
            ? kernel.api.analysis.frequencyDomain
                .manifestV1(reqOpts)
                .catch(() => null)
            : Promise.resolve(null),
          meshManifest === null &&
          typeof kernel.api?.meshing?.sharedDomain?.manifest === "function"
            ? kernel.api.meshing.sharedDomain
                .manifest(reqOpts)
                .catch(() => null)
            : Promise.resolve(null),
          periodicPairs === null &&
          typeof kernel.api?.meshing?.periodicPairs === "function"
            ? kernel.api.meshing.periodicPairs(reqOpts).catch(() => null)
            : Promise.resolve(null),
          solverStatus === null &&
          typeof kernel.api?.simulation?.solver?.status === "function"
            ? kernel.api.simulation.solver.status(reqOpts).catch(() => null)
            : Promise.resolve(null),
          stageExecution === null &&
          typeof kernel.api?.simulation?.stages?.execution === "function"
            ? kernel.api.simulation.stages.execution(reqOpts).catch(() => null)
            : Promise.resolve(null),
        ]);
        checkpointList = checkpointList ?? fetchedCkpts;
        frequencyManifest = frequencyManifest ?? fetchedFreq;
        meshManifest = meshManifest ?? fetchedMesh;
        periodicPairs = periodicPairs ?? fetchedPairs;
        solverStatus = solverStatus ?? fetchedSolver;
        stageExecution = stageExecution ?? fetchedExec;
      }

      return deriveK0ModalExecutionReadiness({
        checkpoints: checkpointList?.checkpoints ?? [],
        equilibriumArtifact: draft.equilibriumArtifact,
        equilibriumSource: draft.equilibriumSource,
        frequencyManifest,
        meshManifest,
        periodicPairs,
        solverStatus,
        stageExecution,
      });
    },
    [kernel.api, kernel.resources, sessionScopeKey],
  );

  const commitGlobalDraft = useCallback(
    async (
      patcher: (baseline: StudyGlobalDraft) => StudyGlobalDraft,
    ): Promise<boolean> => {
      const current = await resolveAuthoritativeScene();
      if (!current) return false;
      const baselineGlobal = createStudyGlobalDraft(current.scene);
      const nextGlobal = patcher(baselineGlobal);
      const profileBound = current.scene
        ? hasStudyExecutionProfile(current.scene)
        : false;
      const sessionDisc = resolveSessionDiscretization(runtimeStatus);
      const requestedDisc =
        runtimeStatus?.capabilities?.active_lane?.requested?.discretization ??
        null;
      const validationErrors = validateStudyGlobalDraft(nextGlobal, {
        studyStages: rawStudyStages(current.scene),
        activeLane: runtimeStatus?.capabilities?.active_lane,
        algorithmsAvailable: runtimeStatus?.capabilities?.algorithms_available,
        executionProfileBound: profileBound,
        magneticObjectCount: magneticObjectCount(current.scene),
        magneticObjectIds: magneticObjectIds(current.scene),
        requestedDiscretization: requestedDisc,
        sessionDiscretization: sessionDisc,
      }).filter((issue) => issue.severity === "error");
      if (validationErrors.length > 0) {
        setLastAuthoringError(
          validationErrors.map((issue) => issue.message).join(" "),
        );
        return false;
      }
      const explicitFdm = isExplicitFdmStudy({
        requestedBackend: profileBound ? null : nextGlobal.requestedBackend,
        requestedDiscretization: requestedDisc,
        sessionDiscretization: sessionDisc,
      });
      let request: AuthoringTransactionRequest;
      try {
        request = buildStudyGlobalMergePatch(nextGlobal, {
          baseRevision: current.revision,
          baselineDraft: baselineGlobal,
          executionProfileBound: profileBound,
          requestedDiscretization: requestedDisc,
          sessionDiscretization: sessionDisc,
        });
      } catch (error) {
        setLastAuthoringError(
          error instanceof Error
            ? error.message
            : "Invalid global study settings.",
        );
        return false;
      }
      return submitTransaction(
        "Edit global study settings",
        current.scene,
        request,
        { refreshFdmGrid: explicitFdm },
      );
    },
    [resolveAuthoritativeScene, runtimeStatus, submitTransaction],
  );

  const commitStudyMetadata = useCallback(
    async (studyPatch: Record<string, unknown>): Promise<boolean> => {
      const current = await resolveAuthoritativeScene();
      if (!current) return false;
      const request: AuthoringTransactionRequest = {
        base_revision: current.revision,
        kind: "merge_patch",
        merge_patch: { study: studyPatch as Record<string, JsonValue> },
      };
      return submitTransaction("Update study metadata", current.scene, request);
    },
    [resolveAuthoritativeScene, submitTransaction],
  );

  const commitExecutionProfile = useCallback(
    async (assignment: StudyExecutionProfileAssignment): Promise<boolean> => {
      const current = await resolveAuthoritativeScene();
      if (!current) return false;
      let request: AuthoringTransactionRequest;
      try {
        request = buildStudyExecutionProfileAssignmentMergePatch(
          assignment,
          current.revision,
        );
      } catch (error) {
        setLastAuthoringError(
          error instanceof Error
            ? error.message
            : "Invalid study execution profile.",
        );
        return false;
      }
      return submitTransaction(
        "Assign study execution profile",
        current.scene,
        request,
      );
    },
    [resolveAuthoritativeScene, submitTransaction],
  );

  const commitSelectedStageDraft = useCallback(
    async (
      patcher: (baseline: StudyStageDraft) => StudyStageDraft,
      fallbackKind: StudyStageDraftKind,
    ): Promise<boolean> => {
      const current = await resolveAuthoritativeScene();
      if (!current) return false;
      const currentGlobal = createStudyGlobalDraft(current.scene);
      const currentDrafts = extractStudyStageDraftsFromScene(current.scene);
      const matched = matchSelectedStageDraft(currentDrafts, selection);
      const baseStage =
        matched.draft ??
        createDefaultStudyStageDraft(fallbackKind, matched.index);
      const updated = patcher(baseStage);
      const profileBound = current.scene
        ? hasStudyExecutionProfile(current.scene)
        : false;
      if (!updated.pipelineNodeId && profileBound && updated.kind === "change_device") {
        setLastAuthoringError(
          "A Change device stage cannot be saved while an execution profile is bound. Remove the stage or clear the profile first.",
        );
        return false;
      }

      const k0Readiness = await resolveK0Readiness(updated);
      const validationErrors = validateStudyStageDraft(updated, {
        activeLane: runtimeStatus?.capabilities?.active_lane,
        algorithmsAvailable: runtimeStatus?.capabilities?.algorithms_available,
        backend: currentGlobal.requestedBackend,
        demagEnabled: currentGlobal.demagEnabled,
        device: currentGlobal.requestedDevice,
        ...k0Readiness,
        mode: currentGlobal.requestedMode,
        precision: currentGlobal.requestedPrecision,
      }).filter((issue) => issue.severity === "error");

      const nextDrafts =
        matched.draft && matched.index < currentDrafts.length
          ? currentDrafts.map((item, idx) =>
              idx === matched.index ? updated : item,
            )
          : [...currentDrafts, updated];

      const workflowErrors = validateStudyWorkflow(nextDrafts)
        .filter(
          (issue) =>
            issue.severity === "error" &&
            (!updated.pipelineNodeId || nextDrafts[issue.index] === updated),
        )
        .map((issue) => ({
          message: `Stage ${issue.index + 1}: ${issue.message}`,
          severity: issue.severity,
        }));

      const allErrors = [...validationErrors, ...workflowErrors];
      if (allErrors.length > 0) {
        setLastAuthoringError(
          allErrors.map((issue) => issue.message).join(" "),
        );
        return false;
      }

      if (updated.pipelineNodeId && current.scene) {
        let request: AuthoringTransactionRequest;
        try {
          request = buildStudyPipelineStageMergePatch(
            updated,
            current.revision,
            current.scene,
          );
        } catch (error) {
          setLastAuthoringError(
            error instanceof Error
              ? error.message
              : "Invalid canonical pipeline stage configuration.",
          );
          return false;
        }
        return submitTransaction("Edit study stage", current.scene, request);
      }

      let request: AuthoringTransactionRequest;
      try {
        request = buildStudyStagesMergePatch(
          nextDrafts,
          current.revision,
          current.scene ?? undefined,
        );
      } catch (error) {
        setLastAuthoringError(
          error instanceof Error
            ? error.message
            : "Invalid study stage configuration.",
        );
        return false;
      }
      return submitTransaction("Edit study stages", current.scene, request);
    },
    [
      resolveAuthoritativeScene,
      resolveK0Readiness,
      runtimeStatus,
      selection,
      submitTransaction,
    ],
  );

  const commitStageDraftList = useCallback(
    async (nextDrafts: readonly StudyStageDraft[]): Promise<boolean> => {
      const current = await resolveAuthoritativeScene();
      if (!current) return false;
      const currentSource = readStudyStageSource(current.scene?.study);
      if (currentSource.kind === "pipeline") {
        setLastAuthoringError(
          "Canonical study_pipeline stages are structured as a pipeline graph; edit individual stage nodes rather than overwriting flat study.stages.",
        );
        return false;
      }
      if (
        current.scene &&
        hasStudyExecutionProfile(current.scene) &&
        hasChangeDeviceStudyStage(current.scene, nextDrafts)
      ) {
        setLastAuthoringError(
          "A Change device stage cannot be saved while an execution profile is bound. Remove the stage or clear the profile first.",
        );
        return false;
      }
      const currentGlobal = createStudyGlobalDraft(current.scene);
      const readinessByIndex = await Promise.all(
        nextDrafts.map((draft) => resolveK0Readiness(draft)),
      );
      const localErrors = nextDrafts.flatMap((draft, index) =>
        validateStudyStageDraft(draft, {
          activeLane: runtimeStatus?.capabilities?.active_lane,
          algorithmsAvailable: runtimeStatus?.capabilities?.algorithms_available,
          backend: currentGlobal.requestedBackend,
          demagEnabled: currentGlobal.demagEnabled,
          device: currentGlobal.requestedDevice,
          ...(readinessByIndex[index] ?? {}),
          mode: currentGlobal.requestedMode,
          precision: currentGlobal.requestedPrecision,
        })
          .filter((issue) => issue.severity === "error")
          .map((issue) => `Stage ${index + 1}: ${issue.message}`),
      );
      const workflowErrors = validateStudyWorkflow(nextDrafts)
        .filter((issue) => issue.severity === "error")
        .map((issue) => `Stage ${issue.index + 1}: ${issue.message}`);
      const allErrors = [...localErrors, ...workflowErrors];
      if (allErrors.length > 0) {
        setLastAuthoringError(allErrors.join(" "));
        return false;
      }

      let request: AuthoringTransactionRequest;
      try {
        request = buildStudyStagesMergePatch(
          [...nextDrafts],
          current.revision,
          current.scene ?? undefined,
        );
      } catch (error) {
        setLastAuthoringError(
          error instanceof Error
            ? error.message
            : "Invalid study stage sequence.",
        );
        return false;
      }
      return submitTransaction("Edit study stages", current.scene, request);
    },
    [
      resolveAuthoritativeScene,
      resolveK0Readiness,
      runtimeStatus,
      submitTransaction,
    ],
  );

  const resolveFreshStudyCommandContext = useCallback(
    async (refreshRuntimeSnapshots: boolean, sourceDetail = "study") => {
      const reqOpts = sessionScopeKey ? { sessionScopeKey } : undefined;
      const [fetchedStatus, fetchedReadiness, fetchedScene] =
        refreshRuntimeSnapshots
          ? await Promise.all([
              typeof kernel.api?.sessions?.current?.status === "function"
                ? kernel.api.sessions.current.status(reqOpts).catch(() => undefined)
                : Promise.resolve(undefined),
              typeof kernel.api?.model?.readiness === "function"
                ? kernel.api.model.readiness(reqOpts).catch(() => undefined)
                : Promise.resolve(undefined),
              typeof kernel.api?.model?.scene === "function"
                ? kernel.api.model.scene(reqOpts).catch(() => undefined)
                : Promise.resolve(undefined),
            ])
          : [undefined, undefined, undefined];

      const committedScene = latestCommittedSceneRef.current;
      const baseScene = scene.data ?? null;
      const baseRev = readNumericSceneRevision(baseScene) ?? -1;
      const committedRev = readNumericSceneRevision(committedScene) ?? -1;
      const fetchedRev = readNumericSceneRevision(fetchedScene) ?? -1;
      const effectiveScene =
        fetchedScene && fetchedRev >= committedRev && fetchedRev >= baseRev
          ? fetchedScene
          : committedScene && committedRev >= baseRev
            ? committedScene
            : fetchedScene ?? baseScene;
      const effectiveStatus = fetchedStatus ?? runtimeStatus;
      const extraResourceData: Record<string, unknown> = {};
      if (fetchedReadiness !== undefined) {
        extraResourceData[MODEL_READINESS_PATH] = fetchedReadiness;
      }
      return {
        commandContext: buildStudyCommandContext(kernel, {
          extraResourceData,
          runtimeStatus: effectiveStatus,
          sceneData: effectiveScene,
          sessionScopeKey,
          sourceDetail,
        }),
        effectiveScene,
      };
    },
    [kernel, runtimeStatus, scene.data, sessionScopeKey],
  );

  const executeStudyCommand = useCallback(
    async (commandId: string, input?: Record<string, unknown>) => {
      const resolvedInput =
        commandId === "study.execute-stage" &&
        input &&
        !("initialState" in input)
          ? { ...input, initialState: { kind: "default_for_target" as const } }
          : input;
      const { commandContext } = await resolveFreshStudyCommandContext(
        commandId.startsWith("study."),
        "study",
      );
      await kernel.commands.execute(commandId, commandContext, resolvedInput);
    },
    [kernel.commands, resolveFreshStudyCommandContext],
  );

  const executeSelectedStage = useCallback(
    async (
      stageId: string,
      initialState?: StageInitialStateChoice,
      explicitKind?: StudyStageDraftKind,
    ) => {
      const { commandContext, effectiveScene } =
        await resolveFreshStudyCommandContext(true, "study");
      const effectiveDrafts =
        effectiveScene && "study" in effectiveScene
          ? extractStudyStageDraftsFromScene(effectiveScene)
          : stageDrafts;
      const matched = effectiveDrafts.find(
        (candidate) =>
          candidate.pipelineNodeId === stageId || candidate.stageId === stageId,
      );
      const resolvedKind =
        explicitKind ?? matched?.kind ?? selectedStageDraft?.kind;
      if (resolvedKind === "run" || resolvedKind === "relax") {
        await kernel.commands.execute("study.execute-stage", commandContext, {
          initialState: initialState ?? { kind: "default_for_target" },
          stageId,
        });
        return;
      }
      await kernel.commands.execute("study.run", commandContext);
    },
    [
      kernel.commands,
      resolveFreshStudyCommandContext,
      selectedStageDraft?.kind,
      stageDrafts,
    ],
  );

  return {
    clearAuthoringError: () => setLastAuthoringError(null),
    commitExecutionProfile,
    commitGlobalDraft,
    commitSelectedStageDraft,
    commitStageDraftList,
    commitStudyMetadata,
    executeSelectedStage,
    executeStudyCommand,
    executionProfileBound: scene.data ? hasStudyExecutionProfile(scene.data) : false,
    globalDraft,
    isCanonicalPipeline: stageSource.kind === "pipeline",
    lastAuthoringError,
    pipelineStripSteps,
    requestedDiscretization,
    runtimeStatus,
    sceneData: scene.data ?? null,
    sceneRevision: readNumericSceneRevision(scene.data),
    sceneStatus: scene.status,
    selectedStageDraft,
    selectedStageIndex,
    sessionDiscretization,
    sessionScopeKey,
    stageDrafts,
  };
}

export function useKernelStudyRuntimeTelemetry(selection: Selection) {
  const scene = useSceneResource();
  const runtimeStatus = useSessionStatusSelector((state) => state.data);
  const fullRuntimeStatus = runtimeStatus?.resources ? runtimeStatus : null;
  const currentRun = useCurrentRunResource({
    enabled: shouldLoadRuntimeCurrentRun(true, fullRuntimeStatus),
  });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(true, fullRuntimeStatus),
  });
  const solverStatus = useSolverStatusResource();
  const commandQueue = useCommandQueueResource({ enabled: false });

  const scopedStageExecutionData = stageExecutionForCurrentScope(
    stageExecution.data,
    {
      expectedRunId: runtimeStatus?.run?.run_id ?? null,
      expectedSessionEpoch: runtimeStatus?.session?.session_epoch ?? null,
      expectedSessionId: runtimeStatus?.session?.session_id ?? null,
      resourceStatus: stageExecution.status,
      scopeReady: Boolean(runtimeStatus?.session),
    },
  );
  const snapshot = useMemo(
    () => studySnapshotFromScene(scene.data),
    [scene.data],
  );
  const activeLane = runtimeStatus?.capabilities?.active_lane ?? null;
  const expectedRunId = runtimeStatus?.run?.run_id ?? null;
  const expectedSessionId = runtimeStatus?.session?.session_id ?? null;
  const model = useMemo(() => {
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
    return resolveStudyInspectorModel({
      activeLane,
      commandQueue: commandQueue.data,
      currentRun:
        currentRun.data &&
        currentRun.data.run_id === expectedRunId &&
        currentRun.data.session_id === expectedSessionId
          ? currentRun.data
          : null,
      energyHistory: null,
      selectedNodeId: selection.nodeId,
      selectedStageRef,
      snapshot,
      solverStatus: solverStatus.data,
      stageExecution: scopedStageExecutionData,
    });
  }, [
    activeLane,
    commandQueue.data,
    currentRun.data,
    expectedRunId,
    expectedSessionId,
    scopedStageExecutionData,
    selection.nodeId,
    selection.ref,
    snapshot,
    solverStatus.data,
  ]);

  return {
    model,
    selectedStageModel: model.selectedStage,
    solverStatus: solverStatus.data,
    stageExecution: scopedStageExecutionData,
  };
}

export function useKernelStudyRecoveryResources() {
  const checkpoints = useCheckpointCatalogResource();
  const solverEnergy = useSolverEnergyCurrentResource();
  const energyHistory = useSolverEnergyHistoryResource(120, { enabled: true });
  const solverStatus = useSolverStatusResource();
  return { checkpoints, energyHistory, solverEnergy, solverStatus };
}
