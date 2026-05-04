import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommandContextValue,
  ModelContextValue,
  ViewportContextValue,
} from "./context-hooks";
import {
  buildMeshBuildStages,
  deriveEffectiveMeshTargets,
  deriveMeshBuildProgressValue,
  deriveMeshBuildRuntimeState,
  meshBuildIntentForNode,
  meshWorkspaceNodeToDockTab,
} from "./meshWorkspace";

type MeshBuildIntent = ReturnType<typeof meshBuildIntentForNode>;

interface UseMeshBuildFlowInput {
  command: Pick<
    CommandContextValue,
    | "activity"
    | "commandMessage"
    | "commandStatus"
    | "engineLog"
    | "latestBackendError"
    | "scriptSyncBusy"
    | "syncScriptBuilder"
    | "workspaceStatus"
  >;
  model: Pick<
    ModelContextValue,
    | "effectiveFemMesh"
    | "femMesh"
    | "handleAirboxMeshGenerate"
    | "handleObjectMeshOverrideRebuild"
    | "handleStudyDomainMeshGenerate"
    | "meshConfigDirty"
    | "meshGenerating"
    | "meshOptions"
    | "meshWorkspace"
    | "modelBuilderGraph"
    | "openFemMeshWorkspace"
    | "sceneDocument"
    | "selectedSidebarNodeId"
    | "setSelectedSidebarNodeId"
  >;
  viewport: Pick<ViewportContextValue, "handleViewModeChange">;
  hasSharedAirboxDomain: boolean;
  scriptPath: string | null;
  selectModelNode: (nodeId: string) => void;
  setRightInspectorOpen: (open: boolean) => void;
  setRightInspectorTab: (tab: "properties") => void;
}

export function useMeshBuildFlow({
  command,
  model,
  viewport,
  hasSharedAirboxDomain,
  scriptPath,
  selectModelNode,
  setRightInspectorOpen,
  setRightInspectorTab,
}: UseMeshBuildFlowInput) {
  const [meshBuildDialogOpen, setMeshBuildDialogOpen] = useState(false);
  const [meshBuildIntent, setMeshBuildIntent] = useState<MeshBuildIntent | null>(null);
  const [meshBuildError, setMeshBuildError] = useState<string | null>(null);
  const [meshBuildOpenedAt, setMeshBuildOpenedAt] = useState<number | null>(null);
  const [meshBuildNotice, setMeshBuildNotice] = useState<{ title: string; message: string } | null>(null);
  const awaitingMeshBuildCompletionRef = useRef(false);
  const meshBuildAutoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meshBuildNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeMeshIntent = useMemo(
    () =>
      meshBuildIntentForNode({
        mode: "selected",
        nodeId: model.selectedSidebarNodeId,
        sceneDocument: model.sceneDocument,
        modelBuilderGraph: model.modelBuilderGraph,
        hasSharedAirboxDomain,
      }),
    [model.modelBuilderGraph, model.sceneDocument, model.selectedSidebarNodeId, hasSharedAirboxDomain],
  );

  const effectiveMeshTargets = useMemo(
    () =>
      deriveEffectiveMeshTargets({
        sceneDocument: model.sceneDocument,
        meshOptions: model.meshOptions,
      }),
    [model.meshOptions, model.sceneDocument],
  );

  const meshBuildStages = useMemo(
    () =>
      buildMeshBuildStages({
        meshWorkspace: model.meshWorkspace,
        workspaceStatus: command.workspaceStatus,
        meshGenerating: model.meshGenerating,
        scriptSyncBusy: command.scriptSyncBusy,
        latestActivityLabel: command.activity.label ?? null,
        latestActivityDetail: command.activity.detail ?? null,
        commandMessage: command.commandMessage,
        engineLog: command.engineLog,
      }),
    [
      command.activity.detail,
      command.activity.label,
      command.commandMessage,
      command.engineLog,
      command.scriptSyncBusy,
      command.workspaceStatus,
      model.meshGenerating,
      model.meshWorkspace,
    ],
  );

  const meshBuildRuntime = useMemo(
    () =>
      deriveMeshBuildRuntimeState({
        meshWorkspace: model.meshWorkspace,
        commandStatus: command.commandStatus,
        meshGenerating: model.meshGenerating,
        scriptSyncBusy: command.scriptSyncBusy,
      }),
    [command.commandStatus, command.scriptSyncBusy, model.meshGenerating, model.meshWorkspace],
  );

  const meshBuildProgress = useMemo(
    () =>
      deriveMeshBuildProgressValue(
        meshBuildStages,
        command.activity.progressMode === "determinate" ? command.activity.progressValue : null,
      ),
    [command.activity.progressMode, command.activity.progressValue, meshBuildStages],
  );

  const meshBuildBackendError = useMemo(
    () =>
      command.latestBackendError &&
      meshBuildOpenedAt != null &&
      command.latestBackendError.timestampUnixMs >= meshBuildOpenedAt
        ? command.latestBackendError
        : null,
    [command.latestBackendError, meshBuildOpenedAt],
  );

  const ensureMeshBuildModal = useCallback((intent: MeshBuildIntent) => {
    setMeshBuildError(null);
    setMeshBuildIntent(intent);
    setMeshBuildOpenedAt(Date.now());
    setMeshBuildDialogOpen(true);
    awaitingMeshBuildCompletionRef.current = true;
    if (meshBuildAutoCloseTimerRef.current) {
      clearTimeout(meshBuildAutoCloseTimerRef.current);
      meshBuildAutoCloseTimerRef.current = null;
    }
  }, []);

  const syncIfPossible = useCallback(async () => {
    if (!scriptPath || command.scriptSyncBusy) {
      return;
    }
    await command.syncScriptBuilder();
  }, [command, scriptPath]);

  const openMeshNode = useCallback((nodeId: string) => {
    selectModelNode(nodeId);
    const dockTab = meshWorkspaceNodeToDockTab(nodeId);
    if (dockTab) {
      model.openFemMeshWorkspace(dockTab);
    }
  }, [model, selectModelNode]);

  const handleBuildMeshSelected = useCallback(async () => {
    const intent = meshBuildIntentForNode({
      mode: "selected",
      nodeId: model.selectedSidebarNodeId,
      sceneDocument: model.sceneDocument,
      modelBuilderGraph: model.modelBuilderGraph,
      hasSharedAirboxDomain,
    });
    ensureMeshBuildModal(intent);
    try {
      switch (intent.buildIntent.target.kind) {
        case "object_mesh":
          await model.handleObjectMeshOverrideRebuild(intent.buildIntent.target.object_id);
          return;
        case "airbox":
          await syncIfPossible();
          await model.handleAirboxMeshGenerate();
          return;
        case "study_domain":
          await syncIfPossible();
          await model.handleStudyDomainMeshGenerate("manual_ui_rebuild_selected");
          return;
      }
    } catch (error) {
      setMeshBuildError(error instanceof Error ? error.message : "Mesh build failed");
    }
  }, [ensureMeshBuildModal, hasSharedAirboxDomain, model, syncIfPossible]);

  const handleBuildMeshAll = useCallback(async () => {
    const intent = meshBuildIntentForNode({
      mode: "all",
      nodeId: model.selectedSidebarNodeId,
      sceneDocument: model.sceneDocument,
      modelBuilderGraph: model.modelBuilderGraph,
      hasSharedAirboxDomain,
    });
    ensureMeshBuildModal(intent);
    try {
      await syncIfPossible();
      await model.handleStudyDomainMeshGenerate("manual_ui_rebuild_all");
    } catch (error) {
      setMeshBuildError(error instanceof Error ? error.message : "Mesh build failed");
    }
  }, [ensureMeshBuildModal, hasSharedAirboxDomain, model, syncIfPossible]);

  const handleOpenMeshInspector = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-view" : "universe-mesh-view");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, openMeshNode, viewport]);

  const handleOpenMeshStatistics = useCallback(() => {
    const nodeId = hasSharedAirboxDomain ? "mesh-statistics" : "universe-mesh-statistics";
    model.setSelectedSidebarNodeId(nodeId);
    setRightInspectorOpen(true);
    setRightInspectorTab("properties");
  }, [hasSharedAirboxDomain, model, setRightInspectorOpen, setRightInspectorTab]);

  const handleOpenMeshQuality = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-quality" : "universe-mesh-quality");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, openMeshNode, viewport]);

  const handleOpenMeshSize = useCallback(() => {
    if (model.selectedSidebarNodeId?.startsWith("geo-") && model.selectedSidebarNodeId.endsWith("-mesh")) {
      selectModelNode(model.selectedSidebarNodeId);
      model.openFemMeshWorkspace("mesher");
      viewport.handleViewModeChange("3D");
      return;
    }
    openMeshNode(hasSharedAirboxDomain ? "universe-airbox-mesh" : "universe-mesh-size");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, model, openMeshNode, selectModelNode, viewport]);

  const handleOpenMeshTransition = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-transition" : "universe-mesh-transition");
    model.openFemMeshWorkspace("mesher");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, model, openMeshNode, viewport]);

  const handleOpenMeshMethod = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-algorithm" : "universe-mesh-algorithm");
    model.openFemMeshWorkspace("mesher");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, model, openMeshNode, viewport]);

  const handleOpenMeshOptimization = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-quality" : "universe-mesh-quality");
    model.openFemMeshWorkspace("mesher");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, model, openMeshNode, viewport]);

  const handleOpenMeshPipeline = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-pipeline" : "universe-mesh-pipeline");
    viewport.handleViewModeChange("3D");
  }, [hasSharedAirboxDomain, openMeshNode, viewport]);

  const handleBackgroundMeshBuild = useCallback(() => {
    setMeshBuildDialogOpen(false);
  }, []);

  const handleCloseMeshBuildDialog = useCallback(() => {
    setMeshBuildDialogOpen(false);
    if (!meshBuildRuntime.generating) {
      setMeshBuildError(null);
      setMeshBuildOpenedAt(null);
    }
  }, [meshBuildRuntime.generating]);

  useEffect(() => {
    if (!awaitingMeshBuildCompletionRef.current) {
      return;
    }
    if (meshBuildRuntime.status === "failure") {
      awaitingMeshBuildCompletionRef.current = false;
      return;
    }
    const succeeded =
      !meshBuildRuntime.generating &&
      !meshBuildRuntime.errorMessage &&
      !model.meshConfigDirty;
    if (!succeeded) {
      return;
    }
    awaitingMeshBuildCompletionRef.current = false;
    const nodeCount = model.meshWorkspace?.mesh_summary?.node_count ?? model.femMesh?.nodes.length ?? 0;
    const elementCount = model.meshWorkspace?.mesh_summary?.element_count ?? model.femMesh?.elements.length ?? 0;
    setMeshBuildNotice({
      title: "Mesh build completed",
      message: `${nodeCount.toLocaleString()} nodes · ${elementCount.toLocaleString()} tetrahedra. Viewport is now updated.`,
    });
    if (meshBuildDialogOpen) {
      meshBuildAutoCloseTimerRef.current = setTimeout(() => {
        setMeshBuildDialogOpen(false);
      }, 1200);
    }
  }, [
    meshBuildDialogOpen,
    meshBuildRuntime.errorMessage,
    meshBuildRuntime.generating,
    meshBuildRuntime.status,
    model.femMesh?.elements.length,
    model.femMesh?.nodes.length,
    model.meshConfigDirty,
    model.meshWorkspace?.mesh_summary?.element_count,
    model.meshWorkspace?.mesh_summary?.node_count,
  ]);

  useEffect(() => {
    if (!meshBuildNotice) {
      return;
    }
    if (meshBuildNoticeTimerRef.current) {
      clearTimeout(meshBuildNoticeTimerRef.current);
    }
    meshBuildNoticeTimerRef.current = setTimeout(() => {
      setMeshBuildNotice(null);
    }, 4800);
    return () => {
      if (meshBuildNoticeTimerRef.current) {
        clearTimeout(meshBuildNoticeTimerRef.current);
        meshBuildNoticeTimerRef.current = null;
      }
    };
  }, [meshBuildNotice]);

  useEffect(() => () => {
    if (meshBuildAutoCloseTimerRef.current) {
      clearTimeout(meshBuildAutoCloseTimerRef.current);
    }
    if (meshBuildNoticeTimerRef.current) {
      clearTimeout(meshBuildNoticeTimerRef.current);
    }
  }, []);

  return {
    activeMeshIntent,
    effectiveMeshTargets,
    meshBuildBackendError,
    meshBuildDialogOpen,
    meshBuildError,
    meshBuildIntent,
    meshBuildNotice,
    meshBuildProgress,
    meshBuildRuntime,
    meshBuildStages,
    handleBackgroundMeshBuild,
    handleBuildMeshAll,
    handleBuildMeshSelected,
    handleCloseMeshBuildDialog,
    handleOpenMeshInspector,
    handleOpenMeshMethod,
    handleOpenMeshOptimization,
    handleOpenMeshPipeline,
    handleOpenMeshQuality,
    handleOpenMeshSize,
    handleOpenMeshStatistics,
    handleOpenMeshTransition,
  };
}
