/**
 * useWorkspaceActions – extracted from ControlRoomContext.tsx
 *
 * Workspace action callbacks, command effects, and result workspace CRUD:
 *  handleCompute, openFemMeshWorkspace, requestFocusObject,
 *  applyAntennaTranslation, applyGeometryTranslation,
 *  applyMeshWorkspacePreset, handleViewModeChange, handleSimulationAction,
 *  handleCapture, handleExport, handleStateExport, handleStateImport,
 *  syncScriptBuilder, command derived values, requestPreviewQuantity,
 *  openResultWorkspaceEntry, result workspace CRUD, keyboard shortcuts.
 */
import { startTransition, useCallback, useEffect, useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { currentLiveApiClient } from "../../../../lib/liveApiClient";
import type {
  CommandStatus,
  CurrentDisplaySelection,
  DisplaySelection,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
} from "../../../../lib/session/types";
import type { SolverSettingsState } from "../../../panels/SolverSettingsPanel";
import type { RenderMode } from "../../../preview/FemMeshView3D";
import type {
  FemDockTab,
  FocusObjectRequest,
  VectorComponent,
  ViewportMode,
} from "../shared";
import { parseOptionalNumber } from "../shared";
import {
  commandKindLabel,
  downloadBase64File,
  fileToBase64,
  sameDisplaySelection,
} from "../helpers";
import {
  MESH_WORKSPACE_PRESETS,
  type MeshWorkspacePresetId,
} from "../meshWorkspace";
import type { useBuilderAutoSync } from "./useBuilderAutoSync";
import type { AnalyzeSelectionState } from "../analyzeSelection";
import type { ResultWorkspaceEntry, ResultWorkspaceKind, WorkspaceMode } from "../context-hooks";
import {
  coreTabIdForViewMode,
  useWorkspaceStore,
  type WorkspaceTabInput,
} from "@/lib/workspace/workspace-store";

type LiveApiClient = ReturnType<typeof currentLiveApiClient>;
type BuilderAutoSync = ReturnType<typeof useBuilderAutoSync>;

export interface UseWorkspaceActionsParams {
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  appendFrontendTrace: (level: string, message: string) => void;
  liveApi: LiveApiClient;
  builderAutoSync: BuilderAutoSync;
  localBuilderDraft: SceneDocument | null;
  localBuilderSignature: string;
  session: { script_path?: string | null } | null;
  isFemBackend: boolean;
  workspaceStatus: string | null;
  effectiveViewMode: ViewportMode;
  previewControlsActive: boolean;
  selectedQuantity: string;
  runUntilInput: string;
  solverSettings: SolverSettingsState;
  commandPostInFlight: boolean;
  commandErrorMessage: string | null;
  commandStatus: CommandStatus | null;
  isWaitingForCompute: boolean;
  interactiveEnabled: boolean;
  awaitingCommand: boolean;
  runtimeCanAcceptCommands: boolean;
  resultWorkspaceEntries: ResultWorkspaceEntry[];
  optimisticDisplaySelection: DisplaySelection | null;
  displaySelection: CurrentDisplaySelection | null;
  /** Quantity IDs that are already cached locally in fieldMap (data-plane). */
  cachedFieldQuantities: ReadonlySet<string>;
  // state setters
  setViewMode: Dispatch<SetStateAction<ViewportMode>>;
  setFemDockTab: Dispatch<SetStateAction<FemDockTab>>;
  setMeshRenderMode: Dispatch<SetStateAction<RenderMode>>;
  setMeshClipEnabled: Dispatch<SetStateAction<boolean>>;
  setMeshOpacity: Dispatch<SetStateAction<number>>;
  setComponent: Dispatch<SetStateAction<VectorComponent>>;
  setSelectedSidebarNodeId: Dispatch<SetStateAction<string | null>>;
  setSelectedQuantity: Dispatch<SetStateAction<string>>;
  setFocusObjectRequest: Dispatch<SetStateAction<FocusObjectRequest | null>>;
  setScriptBuilderCurrentModules: Dispatch<SetStateAction<ScriptBuilderCurrentModuleEntry[]>>;
  setSceneDocument: Dispatch<SetStateAction<SceneDocument | null>>;
  setWorkspaceMode: (v: WorkspaceMode | ((prev: WorkspaceMode) => WorkspaceMode)) => void;
  setActiveResultWorkspaceId: Dispatch<SetStateAction<string | null>>;
  setResultWorkspaceEntries: Dispatch<SetStateAction<ResultWorkspaceEntry[]>>;
  setCommandErrorMessage: Dispatch<SetStateAction<string | null>>;
  setStateIoBusy: Dispatch<SetStateAction<boolean>>;
  setStateIoMessage: Dispatch<SetStateAction<string | null>>;
  setScriptSyncBusy: Dispatch<SetStateAction<boolean>>;
  setScriptSyncMessage: Dispatch<SetStateAction<string | null>>;
  setConsoleCollapsed: Dispatch<SetStateAction<boolean>>;
  setOptimisticDisplaySelection: Dispatch<SetStateAction<DisplaySelection | null>>;
  setPreviewMessage: Dispatch<SetStateAction<string | null>>;
  openAnalyze: (next?: Partial<AnalyzeSelectionState>) => void;
  addResultWorkspaceEntry: (entry: {
    key?: string | null;
    kind: ResultWorkspaceKind;
    label: string;
    quantityId?: string | null;
    icon?: string;
    badge?: string | null;
    pinned?: boolean;
    openAfterCreate?: boolean;
  }) => string;
  lastLoggedCommandStatusRef: MutableRefObject<string | null>;
}

export interface UseWorkspaceActionsReturn {
  handleCompute: () => void;
  openFemMeshWorkspace: (tab?: FemDockTab) => void;
  requestFocusObject: (objectId: string) => void;
  applyAntennaTranslation: (moduleName: string, dx: number, dy: number, dz: number) => void;
  applyGeometryTranslation: (geometryName: string, dx: number, dy: number, dz: number) => void;
  applyMeshWorkspacePreset: (presetId: MeshWorkspacePresetId) => void;
  handleViewModeChange: (mode: string) => void;
  handleSimulationAction: (action: string) => void;
  handleCapture: () => void;
  handleExport: () => void;
  handleStateExport: (format: string) => Promise<void>;
  handleStateImport: (
    file: File,
    options?: {
      format?: string;
      applyToWorkspace?: boolean;
      attachToScriptBuilder?: boolean;
    },
  ) => Promise<void>;
  syncScriptBuilder: () => Promise<void>;
  activeCommandKind: string | null;
  activeCommandState: "acknowledged" | "rejected" | "completed" | null;
  commandMessage: string | null;
  commandBusy: boolean;
  canRunCommand: boolean;
  canRelaxCommand: boolean;
  canPauseCommand: boolean;
  canStopCommand: boolean;
  canSkipCommand: boolean;
  primaryRunAction: string;
  primaryRunLabel: string;
  requestPreviewQuantity: (nextQuantity: string) => void;
  openResultWorkspaceEntry: (id: string) => void;
  renameResultWorkspaceEntry: (id: string, label: string) => void;
  removeResultWorkspaceEntry: (id: string) => void;
  duplicateResultWorkspaceEntry: (id: string) => string | null;
  setResultWorkspacePinned: (id: string, pinned: boolean) => void;
}

export function useWorkspaceActions(params: UseWorkspaceActionsParams): UseWorkspaceActionsReturn {
  const {
    enqueueCommand,
    updatePreview,
    appendFrontendTrace,
    liveApi,
    builderAutoSync,
    localBuilderDraft,
    localBuilderSignature,
    session,
    isFemBackend,
    workspaceStatus,
    effectiveViewMode,
    previewControlsActive,
    selectedQuantity,
    runUntilInput,
    solverSettings,
    commandPostInFlight,
    commandErrorMessage,
    commandStatus,
    isWaitingForCompute,
    interactiveEnabled,
    awaitingCommand,
    runtimeCanAcceptCommands,
    resultWorkspaceEntries,
    optimisticDisplaySelection,
    displaySelection,
    cachedFieldQuantities,
    setViewMode,
    setFemDockTab,
    setMeshRenderMode,
    setMeshClipEnabled,
    setMeshOpacity,
    setComponent,
    setSelectedSidebarNodeId,
    setSelectedQuantity,
    setFocusObjectRequest,
    setScriptBuilderCurrentModules,
    setSceneDocument,
    setWorkspaceMode,
    setActiveResultWorkspaceId,
    setResultWorkspaceEntries,
    setCommandErrorMessage,
    setStateIoBusy,
    setStateIoMessage,
    setScriptSyncBusy,
    setScriptSyncMessage,
    setConsoleCollapsed,
    setOptimisticDisplaySelection,
    setPreviewMessage,
    openAnalyze,
    addResultWorkspaceEntry,
    lastLoggedCommandStatusRef,
  } = params;
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const openWorkspaceTab = useWorkspaceStore((state) => state.openTab);
  const activateWorkspaceTab = useWorkspaceStore((state) => state.activateTab);

  /* ── handleCompute ── */
  const handleCompute = useCallback(() => {
    void enqueueCommand({ kind: "solve" });
  }, [enqueueCommand]);

  /* ── openFemMeshWorkspace ── */
  const openFemMeshWorkspace = useCallback((tab: FemDockTab = "mesh") => {
    startTransition(() => {
      setViewMode("Mesh");
      setFemDockTab(tab);
    });
    setMeshRenderMode((c) => (c === "surface" ? "surface+edges" : c));
  }, []);

  /* ── requestFocusObject ── */
  const requestFocusObject = useCallback((objectId: string) => {
    if (!objectId) {
      return;
    }
    setFocusObjectRequest((previous) => ({
      objectId,
      revision: previous && previous.objectId === objectId ? previous.revision + 1 : 1,
    }));
  }, []);

  /* ── applyAntennaTranslation ── */
  const applyAntennaTranslation = useCallback((moduleName: string, dx: number, dy: number, dz: number) => {
    setScriptBuilderCurrentModules((prev) =>
      prev.map((mod) => {
        if (mod.name !== moduleName) return mod;
        const p = mod.antenna_params ?? {};
        return {
          ...mod,
          antenna_params: {
            ...p,
            center_x: (Number(p.center_x) || 0) + dx,
            center_y: (Number(p.center_y) || 0) + dy,
            height_above_magnet: (Number(p.height_above_magnet) || 0) + dz,
          },
        };
      })
    );
  }, [setScriptBuilderCurrentModules]);

  /* ── applyGeometryTranslation ── */
  const applyGeometryTranslation = useCallback((geometryName: string, dx: number, dy: number, dz: number) => {
    setSceneDocument((previousScene) => {
      const baseScene = (previousScene ?? localBuilderDraft)!;
      const nextScene: SceneDocument = {
        ...baseScene,
        objects: baseScene.objects.map((object) => {
          if (object.id !== geometryName && object.name !== geometryName) {
            return object;
          }
          const translation = object.transform.translation ?? [0, 0, 0];
          return {
            ...object,
            transform: {
              ...object.transform,
              translation: [
                Number(translation[0] ?? 0) + dx,
                Number(translation[1] ?? 0) + dy,
                Number(translation[2] ?? 0) + dz,
              ],
            },
          };
        }),
      };
      return nextScene;
    });
  }, [localBuilderDraft, setSceneDocument]);

  /* ── applyMeshWorkspacePreset ── */
  const applyMeshWorkspacePreset = useCallback((presetId: MeshWorkspacePresetId) => {
    const preset = MESH_WORKSPACE_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) return;

    startTransition(() => {
      if (preset.viewMode === "2D") {
        setComponent((prev) => (prev === "magnitude" ? "x" : prev));
      }
      setViewMode(preset.viewMode);
      setFemDockTab(preset.dockTab);
      setSelectedSidebarNodeId(
        preset.dockTab === "quality"
          ? "universe-mesh-quality"
          : preset.dockTab === "mesher"
            ? "universe-mesh-size"
            : preset.dockTab === "pipeline"
              ? "universe-mesh-pipeline"
              : "universe-mesh-view",
      );
    });

    setMeshRenderMode(preset.renderMode);
    if (preset.clipEnabled !== undefined) setMeshClipEnabled(preset.clipEnabled);
    if (preset.opacity != null) setMeshOpacity(preset.opacity);
  }, []);

  /* ── handleViewModeChange ── */
  const handleViewModeChange = useCallback((mode: string) => {
    if (mode === "Mesh") { if (isFemBackend) openFemMeshWorkspace("mesh"); startTransition(() => setViewMode("Mesh")); return; }
    if (mode === "2D") {
      startTransition(() => {
        setComponent((prev) => prev === "magnitude" ? "x" : prev);
      });
    }
    startTransition(() => {
      setViewMode(mode as ViewportMode);
    });
    if (mode === "3D" || mode === "2D" || mode === "Mesh" || mode === "Analyze") {
      activateWorkspaceTab(currentStage, coreTabIdForViewMode(mode as "3D" | "2D" | "Mesh" | "Analyze"));
    }
  }, [activateWorkspaceTab, currentStage, isFemBackend, openFemMeshWorkspace]);

  /* ── handleSimulationAction ── */
  const handleSimulationAction = useCallback((action: string) => {
    if (action === "compute" || action === "solve") {
      handleCompute();
      return;
    }

    if (action === "run") {
      if (workspaceStatus === "paused") {
        void enqueueCommand({ kind: "resume" });
        return;
      }
      const untilSeconds = parseOptionalNumber(runUntilInput);
      if (untilSeconds == null || untilSeconds <= 0) {
        setCommandErrorMessage("Run requires a positive stop time");
        return;
      }
      void enqueueCommand({
        kind: "run",
        until_seconds: untilSeconds,
        integrator: solverSettings.integrator,
        fixed_timestep: parseOptionalNumber(solverSettings.fixedTimestep),
      });
      return;
    }

    if (action === "relax") {
      const maxSteps = parseOptionalNumber(solverSettings.maxRelaxSteps);
      if (maxSteps == null || maxSteps <= 0) {
        setCommandErrorMessage("Relax requires a positive max step count");
        return;
      }
      void enqueueCommand({
        kind: "relax",
        max_steps: maxSteps,
        torque_tolerance: parseOptionalNumber(solverSettings.torqueTolerance),
        energy_tolerance: parseOptionalNumber(solverSettings.energyTolerance),
        relax_algorithm: solverSettings.relaxAlgorithm,
        relax_alpha: parseOptionalNumber(solverSettings.relaxAlpha),
      });
      return;
    }

    if (action === "pause") {
      void enqueueCommand({ kind: "pause" });
      return;
    }

    if (action === "resume") {
      void enqueueCommand({ kind: "resume" });
      return;
    }

    if (action === "stop") {
      void enqueueCommand({ kind: "stop" });
    }

    if (action === "skip") {
      void enqueueCommand({ kind: "skip" });
    }
  }, [
    enqueueCommand,
    handleCompute,
    runUntilInput,
    solverSettings.fixedTimestep,
    solverSettings.integrator,
    solverSettings.energyTolerance,
    solverSettings.maxRelaxSteps,
    solverSettings.relaxAlgorithm,
    solverSettings.relaxAlpha,
    solverSettings.torqueTolerance,
    workspaceStatus,
  ]);

  /* ── handleCapture ── */
  const handleCapture = useCallback(() => {
    // Try viewport-scoped WebGL canvas first (R3F 3D view)
    const canvas =
      document.querySelector<HTMLCanvasElement>("#workspace-viewport canvas") ??
      document.querySelector<HTMLCanvasElement>("[class*='viewport'] canvas");
    if (canvas) {
      const link = document.createElement("a");
      link.download = `fullmag_snapshot_${Date.now()}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      return;
    }
    // Fallback: try any echarts instance on the page
    const echartsContainer = document.querySelector<HTMLDivElement>("[_echarts_instance_]");
    if (echartsContainer) {
      const echartsCanvas = echartsContainer.querySelector<HTMLCanvasElement>("canvas");
      if (echartsCanvas) {
        const link = document.createElement("a");
        link.download = `fullmag_snapshot_${Date.now()}.png`;
        link.href = echartsCanvas.toDataURL("image/png");
        link.click();
        return;
      }
    }
    // Last resort: any canvas
    const anyCanvas = document.querySelector<HTMLCanvasElement>("canvas");
    if (anyCanvas) {
      const link = document.createElement("a");
      link.download = `fullmag_snapshot_${Date.now()}.png`;
      link.href = anyCanvas.toDataURL("image/png");
      link.click();
    }
  }, []);

  /* ── handleExport ── */
  const handleExport = useCallback(() => { void enqueueCommand({ kind: "save_vtk" }); }, [enqueueCommand]);

  /* ── handleStateExport ── */
  const handleStateExport = useCallback(async (format: string) => {
    setStateIoBusy(true);
    setStateIoMessage(null);
    try {
      const response = await liveApi.exportState({ format }) as {
        file_name?: unknown;
        content_base64?: unknown;
        stored_path?: unknown;
      };
      const fileName =
        typeof response.file_name === "string" && response.file_name.trim().length > 0
          ? response.file_name
          : `m_state.${format}`;
      const contentBase64 =
        typeof response.content_base64 === "string" ? response.content_base64 : "";
      if (!contentBase64) {
        throw new Error("Export response did not contain file content");
      }
      downloadBase64File(fileName, contentBase64);
      setStateIoMessage(
        typeof response.stored_path === "string" && response.stored_path.trim().length > 0
          ? `Exported ${fileName} to ${response.stored_path}`
          : `Exported ${fileName}`,
      );
    } catch (error) {
      setStateIoMessage(error instanceof Error ? error.message : "Failed to export state");
    } finally {
      setStateIoBusy(false);
    }
  }, [liveApi]);

  /* ── handleStateImport ── */
  const handleStateImport = useCallback(async (
    file: File,
    options?: {
      format?: string;
      applyToWorkspace?: boolean;
      attachToScriptBuilder?: boolean;
    },
  ) => {
    setStateIoBusy(true);
    setStateIoMessage(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const response = await liveApi.importState({
        file_name: file.name,
        content_base64: contentBase64,
        format: options?.format ?? undefined,
        apply_to_workspace: options?.applyToWorkspace ?? true,
        attach_to_script_builder: options?.attachToScriptBuilder ?? true,
      }) as { stored_path?: unknown; applied_to_workspace?: unknown };
      const importedPath =
        typeof response.stored_path === "string" && response.stored_path.trim().length > 0
          ? response.stored_path
          : file.name;
      const applied =
        typeof response.applied_to_workspace === "boolean"
          ? response.applied_to_workspace
          : (options?.applyToWorkspace ?? true);
      setStateIoMessage(
        applied
          ? `Imported ${file.name} and applied it to the workspace`
          : `Imported ${file.name} to ${importedPath}`,
      );
    } catch (error) {
      setStateIoMessage(error instanceof Error ? error.message : "Failed to import state");
    } finally {
      setStateIoBusy(false);
    }
  }, [liveApi]);

  /* ── syncScriptBuilder ── */
  const syncScriptBuilder = useCallback(async () => {
    const scriptPath = session?.script_path ?? null;
    if (!scriptPath) {
      setScriptSyncMessage("No script path is available for the active workspace");
      appendFrontendTrace("warn", "TX: SCRIPT_SYNC skipped — no script path available");
      return;
    }

    setScriptSyncBusy(true);
    setScriptSyncMessage(null);
    appendFrontendTrace("info", `TX: SCRIPT_SYNC ${scriptPath}`);
    try {
      builderAutoSync.cancelPendingPush();
      await liveApi.updateSceneDocument(localBuilderDraft);
      builderAutoSync.recordPushSignature(localBuilderSignature);
      const response = await liveApi.syncScript();
      const syncedPath =
        typeof response.script_path === "string" && response.script_path.trim().length > 0
          ? response.script_path
          : scriptPath;
      setScriptSyncMessage(`Synced ${syncedPath.split("/").pop() ?? "script"} to canonical Python`);
      appendFrontendTrace(
        "success",
        `RX: SCRIPT_SYNC ok — ${syncedPath.split("/").pop() ?? "script"}`,
      );
    } catch (error) {
      setScriptSyncMessage(error instanceof Error ? error.message : "Failed to sync script");
      appendFrontendTrace(
        "error",
        `RX: SCRIPT_SYNC failed — ${error instanceof Error ? error.message : "Failed to sync script"}`,
      );
    } finally {
      setScriptSyncBusy(false);
    }
  }, [appendFrontendTrace, liveApi, localBuilderDraft, localBuilderSignature, session?.script_path]);

  /* ── useEffect: command status logging ── */
  useEffect(() => {
    if (!commandStatus) return;
    const key = [
      commandStatus.command_id,
      commandStatus.state,
      commandStatus.completion_state ?? "",
      commandStatus.reason ?? "",
    ].join("|");
    if (lastLoggedCommandStatusRef.current === key) return;
    lastLoggedCommandStatusRef.current = key;

    const commandKind = commandStatus.command_kind.toUpperCase();
    if (commandStatus.state === "acknowledged") {
      appendFrontendTrace(
        "system",
        `RX: ${commandKind} ACK seq=${commandStatus.seq ?? "?"} id=${commandStatus.command_id}`,
      );
      return;
    }
    if (commandStatus.state === "rejected") {
      appendFrontendTrace(
        "error",
        `RX: ${commandKind} REJECTED — ${commandStatus.reason ?? "unknown reason"}`,
      );
      return;
    }
    appendFrontendTrace(
      commandStatus.completion_state && commandStatus.completion_state !== "ok" ? "warn" : "success",
      `RX: ${commandKind} COMPLETED${commandStatus.completion_state ? ` (${commandStatus.completion_state})` : ""}`,
    );
  }, [appendFrontendTrace, commandStatus]);

  /* ── useEffect: optimistic display selection sync ── */
  useEffect(() => {
    if (!optimisticDisplaySelection) {
      return;
    }
    const committedSelection = displaySelection?.selection ?? null;
    if (sameDisplaySelection(optimisticDisplaySelection, committedSelection)) {
      setOptimisticDisplaySelection(null);
      setPreviewMessage(null);
    }
  }, [displaySelection, optimisticDisplaySelection]);

  /* ── useEffect: command rejection ── */
  useEffect(() => {
    if (commandStatus?.state === "rejected" && optimisticDisplaySelection) {
      setOptimisticDisplaySelection(null);
    }
  }, [commandStatus?.state, optimisticDisplaySelection]);

  /* ── Command derived values ── */
  const activeCommandKind = commandStatus?.command_kind ?? null;
  const activeCommandState = commandStatus?.state ?? null;
  const commandMessage = useMemo(() => {
    if (commandErrorMessage) {
      return commandErrorMessage;
    }
    if (commandPostInFlight) {
      return "Sending command to runtime…";
    }
    if (!commandStatus) {
      return null;
    }
    const label = commandKindLabel(commandStatus.command_kind);
    if (commandStatus.state === "rejected") {
      return commandStatus.reason ? `${label} rejected: ${commandStatus.reason}` : `${label} rejected`;
    }
    if (commandStatus.state === "acknowledged") {
      return `${label} acknowledged`;
    }
    if (commandStatus.completion_state && commandStatus.completion_state !== "ok") {
      return `${label} ${commandStatus.completion_state}`;
    }
    return `${label} completed`;
  }, [commandErrorMessage, commandPostInFlight, commandStatus]);

  const commandBusy = commandPostInFlight;
  const canRunCommand =
    interactiveEnabled &&
    (awaitingCommand || isWaitingForCompute || workspaceStatus === "paused") &&
    runtimeCanAcceptCommands &&
    !commandBusy;
  const canRelaxCommand =
    interactiveEnabled &&
    awaitingCommand &&
    runtimeCanAcceptCommands &&
    !commandBusy;
  const canPauseCommand =
    interactiveEnabled &&
    workspaceStatus === "running" &&
    runtimeCanAcceptCommands &&
    !commandBusy;
  const canStopCommand =
    interactiveEnabled &&
    (isWaitingForCompute || workspaceStatus === "running" || workspaceStatus === "paused") &&
    runtimeCanAcceptCommands &&
    !commandBusy;
  const canSkipCommand =
    interactiveEnabled &&
    workspaceStatus === "running" &&
    runtimeCanAcceptCommands &&
    !commandBusy;
  const primaryRunAction =
    isWaitingForCompute ? "compute" : workspaceStatus === "paused" ? "resume" : "run";
  const primaryRunLabel =
    isWaitingForCompute ? "Compute" : workspaceStatus === "paused" ? "Resume" : "Run";

  /* ── requestPreviewQuantity ── */
  const requestPreviewQuantity = useCallback((nextQuantity: string) => {
    startTransition(() => {
      if (isFemBackend && effectiveViewMode === "Mesh") setViewMode("3D");
      setSelectedQuantity(nextQuantity);
    });
    // Data-plane fast path: if the field buffer is already cached locally,
    // skip the control-plane POST entirely — just set local state.
    if (cachedFieldQuantities.has(nextQuantity)) {
      return;
    }
    // Fallback: ask the backend to compute/publish the field via the
    // preview command queue (control-plane path).
    if (previewControlsActive) {
      void updatePreview("/quantity", { quantity: nextQuantity });
    }
  }, [cachedFieldQuantities, effectiveViewMode, isFemBackend, previewControlsActive, updatePreview]);

  /* ── openResultWorkspaceEntry ── */
  const openResultWorkspaceEntry = useCallback(
    (id: string) => {
      setActiveResultWorkspaceId(id);
      setSelectedSidebarNodeId(`res-analysis-${id}`);
      const entry = resultWorkspaceEntries.find((candidate) => candidate.id === id);
      if (!entry) {
        return;
      }
      const tabKind: WorkspaceTabInput["kind"] =
        entry.kind === "spectrum"
          ? "result-spectrum"
          : entry.kind === "dispersion"
            ? "result-dispersion"
            : entry.kind === "modes"
              ? "result-modes"
              : entry.kind === "time-traces"
                ? "result-time-traces"
                : entry.kind === "vortex-frequency"
                  ? "result-vortex-frequency"
                  : entry.kind === "vortex-trajectory"
                    ? "result-vortex-trajectory"
                    : entry.kind === "vortex-orbit"
                      ? "result-vortex-orbit"
                      : entry.kind === "table"
                        ? "result-table"
                        : "result-quantity";
      const openedTabId = openWorkspaceTab("analyze", {
        key: `result:${entry.id}`,
        id: `result-tab:${entry.id}`,
        kind: tabKind,
        title: entry.label,
        closable: true,
        pinned: entry.pinned,
        keepAlive: tabKind === "result-quantity",
        payload: {
          resultWorkspaceId: entry.id,
          quantityId: entry.quantityId ?? undefined,
        },
      });
      activateWorkspaceTab("analyze", openedTabId);
      if (entry.kind === "spectrum") {
        setWorkspaceMode("analyze");
        openAnalyze({ tab: "spectrum", selectedModeIndex: null });
        return;
      }
      if (entry.kind === "dispersion") {
        setWorkspaceMode("analyze");
        openAnalyze({ tab: "dispersion", selectedModeIndex: null });
        return;
      }
      if (entry.kind === "modes") {
        setWorkspaceMode("analyze");
        openAnalyze({ tab: "modes" });
        return;
      }
      if (entry.kind === "time-traces") {
        setWorkspaceMode("analyze");
        openAnalyze({ domain: "vortex", tab: "time-traces" });
        return;
      }
      if (entry.kind === "vortex-frequency") {
        setWorkspaceMode("analyze");
        openAnalyze({ domain: "vortex", tab: "vortex-frequency" });
        return;
      }
      if (entry.kind === "vortex-trajectory") {
        setWorkspaceMode("analyze");
        openAnalyze({ domain: "vortex", tab: "vortex-trajectory" });
        return;
      }
      if (entry.kind === "vortex-orbit") {
        setWorkspaceMode("analyze");
        openAnalyze({ domain: "vortex", tab: "vortex-orbit" });
        return;
      }
      if (entry.kind === "table") {
        setWorkspaceMode("analyze");
        startTransition(() => {
          setViewMode("Analyze");
        });
        return;
      }
      if (entry.quantityId) {
        requestPreviewQuantity(entry.quantityId);
      }
      if (isFemBackend && effectiveViewMode === "Mesh") {
        setViewMode("3D");
      }
    },
    [
      activateWorkspaceTab,
      effectiveViewMode,
      isFemBackend,
      openAnalyze,
      openWorkspaceTab,
      requestPreviewQuantity,
      resultWorkspaceEntries,
      setWorkspaceMode,
    ],
  );

  /* ── renameResultWorkspaceEntry ── */
  const renameResultWorkspaceEntry = useCallback((id: string, label: string) => {
    const next = label.trim();
    if (!next) {
      return;
    }
    setResultWorkspaceEntries((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, label: next } : entry)),
    );
  }, []);

  /* ── removeResultWorkspaceEntry ── */
  const removeResultWorkspaceEntry = useCallback((id: string) => {
    setResultWorkspaceEntries((prev) => prev.filter((entry) => entry.id !== id));
    setActiveResultWorkspaceId((prev) => (prev === id ? null : prev));
    setSelectedSidebarNodeId((prev) => (prev === `res-analysis-${id}` ? "res-analyses" : prev));
  }, []);

  /* ── duplicateResultWorkspaceEntry ── */
  const duplicateResultWorkspaceEntry = useCallback((id: string) => {
    const source = resultWorkspaceEntries.find((entry) => entry.id === id);
    if (!source) {
      return null;
    }
    return addResultWorkspaceEntry({
      key: `user:duplicate:${source.kind}:${Date.now()}:${Math.floor(Math.random() * 10000)}`,
      kind: source.kind,
      label: `${source.label} (copy)`,
      quantityId: source.quantityId,
      icon: source.icon,
      badge: source.badge,
      pinned: true,
      openAfterCreate: true,
    });
  }, [addResultWorkspaceEntry, resultWorkspaceEntries]);

  /* ── setResultWorkspacePinned ── */
  const setResultWorkspacePinned = useCallback((id: string, pinned: boolean) => {
    setResultWorkspaceEntries((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, pinned } : entry)),
    );
  }, []);

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1") setViewMode("3D");
      else if (e.key === "2") setViewMode("2D");
      else if (e.key === "3") handleViewModeChange("Mesh");
      else if (e.key === "`" && e.ctrlKey) { e.preventDefault(); setConsoleCollapsed((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleViewModeChange]);

  return {
    handleCompute,
    openFemMeshWorkspace,
    requestFocusObject,
    applyAntennaTranslation,
    applyGeometryTranslation,
    applyMeshWorkspacePreset,
    handleViewModeChange,
    handleSimulationAction,
    handleCapture,
    handleExport,
    handleStateExport,
    handleStateImport,
    syncScriptBuilder,
    activeCommandKind,
    activeCommandState,
    commandMessage,
    commandBusy,
    canRunCommand,
    canRelaxCommand,
    canPauseCommand,
    canStopCommand,
    canSkipCommand,
    primaryRunAction,
    primaryRunLabel,
    requestPreviewQuantity,
    openResultWorkspaceEntry,
    renameResultWorkspaceEntry,
    removeResultWorkspaceEntry,
    duplicateResultWorkspaceEntry,
    setResultWorkspacePinned,
  };
}
