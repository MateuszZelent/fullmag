/**
 * useWorkspaceActions – extracted from ControlRoomContext.tsx
 *
 * Workspace action callbacks, command effects, and result workspace CRUD:
 *  handleCompute, openFemMeshWorkspace, requestFocusObject,
 *  applyAntennaTranslation, applyGeometryTranslation,
 *  applyMeshWorkspacePreset, handleViewModeChange, handleSimulationAction,
 *  handleCapture, handleExport, handleStateExport, handleStateImport,
 *  syncScriptBuilder, command derived values, requestDisplayQuantity,
 *  openResultWorkspaceEntry, result workspace CRUD, keyboard shortcuts.
 */
import { startTransition, useCallback, useEffect, useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type {
  CommandStatus,
  CurrentDisplaySelection,
  DisplaySelection,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
} from "../../../../lib/session/types";
import type { SolverSettingsState } from "../../../panels/SolverSettingsPanel";
import type { RenderMode } from "@/components/preview/FemMeshView3D";
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
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import {
  MESH_WORKSPACE_PRESETS,
  type MeshWorkspacePresetId,
} from "../meshWorkspace";
import type { useBuilderAutoSync } from "./useBuilderAutoSync";
import type { AnalyzeSelectionState } from "../analyzeSelection";
import type {
  OpenAnalyzeSurfaceOptions,
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
} from "../context-hooks";
import {
  coreTabIdForViewMode,
  useWorkspaceStore,
  type WorkspaceTabInput,
} from "@/lib/workspace/workspace-store";
import type { ControlRoomApi } from "../controlRoomApi";
import type { CapabilityMap, SaveProfile, VisualizationStatePatch } from "@/src/api/types";
import { isFemDiscretization } from "@/src/domain/capabilities";
import { hasUnsyncedSceneMagnetization } from "../../../panels/settings/materialPanelMagnetization";
import {
  visualizationPatchForClip,
  visualizationPatchForOpacity,
  visualizationPatchForRenderMode,
} from "../visualizationStateSync";

type NormalizedViewportMode = ViewportMode | "charts";
export type QuantitySwitchCacheState =
  | "field-map-hit"
  | "display-patch"
  | "preview-recompute";

const CHARTS_VIEW_MODE = "charts";

function normalizeViewportMode(mode: string): NormalizedViewportMode | null {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "3d") return "3D";
  if (normalized === "2d") return "2D";
  if (normalized === "mesh") return "Mesh";
  if (normalized === "analyze") return "Analyze";
  if (normalized === "chart" || normalized === "charts") return CHARTS_VIEW_MODE;
  return null;
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function resolveQuantitySwitchCacheState(args: {
  cachedFieldQuantities: ReadonlySet<string>;
  nextQuantity: string;
  previewControlsActive: boolean;
}): QuantitySwitchCacheState {
  const { cachedFieldQuantities, nextQuantity, previewControlsActive } = args;
  if (cachedFieldQuantities.has(nextQuantity)) {
    return "field-map-hit";
  }
  if (previewControlsActive) {
    return "display-patch";
  }
  return "preview-recompute";
}

export function shouldPatchDisplayForQuantitySwitch(args: {
  cacheState: QuantitySwitchCacheState;
  previewControlsActive: boolean;
}): boolean {
  const { cacheState, previewControlsActive } = args;
  return previewControlsActive && cacheState === "display-patch";
}

const FEM_COMPUTE_FIELDS_QUANTITY_FALLBACKS: Readonly<Record<string, string>> = {
  H_ant: "H_eff",
};

export function resolveComputeFieldsQuantity(args: {
  femDiscretization: boolean;
  selectedQuantity: string;
}): string {
  const { femDiscretization, selectedQuantity } = args;
  if (!femDiscretization) {
    return selectedQuantity;
  }
  return FEM_COMPUTE_FIELDS_QUANTITY_FALLBACKS[selectedQuantity] ?? selectedQuantity;
}

type BuilderAutoSync = ReturnType<typeof useBuilderAutoSync>;

function normalizeSessionExportProfile(value: string): SaveProfile {
  switch (value.trim().toLowerCase()) {
    case "resume":
      return "resume";
    case "solved":
    case "zarr":
      return "solved";
    case "archive":
    case "h5":
      return "archive";
    case "recovery":
      return "recovery";
    case "compact":
    case "json":
    default:
      return "compact";
  }
}

function sessionExportFileName(profile: SaveProfile): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `fullmag-session-${profile}-${timestamp}.fms`;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface UseWorkspaceActionsParams {
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  patchDisplay: (patch: VisualizationStatePatch) => Promise<void>;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  appendFrontendTrace: (level: string, message: string) => void;
  liveApi: ControlRoomApi;
  builderAutoSync: BuilderAutoSync;
  localBuilderDraft: SceneDocument | null;
  remoteSceneDocument: SceneDocument | null;
  refreshLiveState: () => Promise<void>;
  localBuilderSignature: string;
  session: { script_path?: string | null } | null;
  isFemBackend: boolean;
  domainCapabilities?: CapabilityMap | null;
  workspaceStatus: string | null;
  effectiveViewMode: ViewportMode;
  meshRenderMode: RenderMode;
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
  setComponent: Dispatch<SetStateAction<VectorComponent>>;
  setSelectedSidebarNodeId: Dispatch<SetStateAction<string | null>>;
  setSelectedQuantity: Dispatch<SetStateAction<string>>;
  setFocusObjectRequest: Dispatch<SetStateAction<FocusObjectRequest | null>>;
  setScriptBuilderCurrentModules: Dispatch<SetStateAction<ScriptBuilderCurrentModuleEntry[]>>;
  setSceneDocument: Dispatch<SetStateAction<SceneDocument | null>>;
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

export async function syncSceneBeforeComputeFields(args: {
  localScene: SceneDocument | null;
  remoteScene: SceneDocument | null;
  liveApi: ControlRoomApi;
  refreshLiveState: () => Promise<void>;
  setSceneDocument: Dispatch<SetStateAction<SceneDocument | null>>;
  setCommandErrorMessage: Dispatch<SetStateAction<string | null>>;
  setPreviewMessage: Dispatch<SetStateAction<string | null>>;
  appendFrontendTrace: (level: string, message: string) => void;
}): Promise<boolean> {
  const {
    localScene,
    remoteScene,
    liveApi,
    refreshLiveState,
    setSceneDocument,
    setCommandErrorMessage,
    setPreviewMessage,
    appendFrontendTrace,
  } = args;

  if (
    !hasUnsyncedSceneMagnetization({
      localScene,
      remoteScene,
    })
  ) {
    return true;
  }

  if (!localScene) {
    return true;
  }

  setCommandErrorMessage(null);
  setPreviewMessage("Syncing magnetic texture before computing fields...");
  appendFrontendTrace("info", "TX: SCENE sync before compute_fields - magnetic texture changed");

  try {
    const committedScene = await liveApi.updateSceneDocument(localScene);
    setSceneDocument(committedScene);
    await refreshLiveState();
    appendFrontendTrace("success", "RX: SCENE sync complete before compute_fields");
    return true;
  } catch (error) {
    const message =
      error instanceof Error
        ? `Compute fields blocked: magnetic texture sync failed: ${error.message}`
        : "Compute fields blocked: magnetic texture sync failed";
    setCommandErrorMessage(message);
    setPreviewMessage("Compute fields blocked: magnetic texture sync failed.");
    appendFrontendTrace("error", `RX: SCENE sync failed before compute_fields - ${message}`);
    return false;
  }
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
      restoreMode?: string;
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
  requestDisplayQuantity: (nextQuantity: string) => void;
  requestPreviewQuantity: (nextQuantity: string) => void;
  openAnalyzeSurface: (options?: OpenAnalyzeSurfaceOptions) => void;
  openResultWorkspaceEntry: (id: string) => void;
  renameResultWorkspaceEntry: (id: string, label: string) => void;
  removeResultWorkspaceEntry: (id: string) => void;
  duplicateResultWorkspaceEntry: (id: string) => string | null;
  setResultWorkspacePinned: (id: string, pinned: boolean) => void;
}

export function useWorkspaceActions(params: UseWorkspaceActionsParams): UseWorkspaceActionsReturn {
  const {
    enqueueCommand,
    patchDisplay,
    updatePreview,
    appendFrontendTrace,
    liveApi,
    builderAutoSync,
    localBuilderDraft,
    remoteSceneDocument,
    refreshLiveState,
    localBuilderSignature,
    session,
    isFemBackend,
    domainCapabilities,
    workspaceStatus,
    effectiveViewMode,
    meshRenderMode,
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
    setComponent,
    setSelectedSidebarNodeId,
    setSelectedQuantity,
    setFocusObjectRequest,
    setScriptBuilderCurrentModules,
    setSceneDocument,
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
  const femDiscretization = domainCapabilities
    ? isFemDiscretization(domainCapabilities)
    : isFemBackend;
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const openWorkspaceTab = useWorkspaceStore((state) => state.openTab);
  const activateWorkspaceTab = useWorkspaceStore((state) => state.activateTab);

  const transitionToViewMode = useCallback((
    nextMode: ViewportMode,
    options?: {
      force?: boolean;
      femDockTab?: FemDockTab;
      beforeTransition?: () => void;
    },
  ) => {
    if (!options?.force && nextMode === effectiveViewMode && !options?.beforeTransition) {
      return;
    }
    startTransition(() => {
      options?.beforeTransition?.();
      if (!options?.force && nextMode === effectiveViewMode) {
        return;
      }
      if (nextMode === "3D" || nextMode === "2D" || nextMode === "Mesh" || nextMode === "Analyze") {
        activateWorkspaceTab(currentStage, coreTabIdForViewMode(nextMode));
      }
      setViewMode(nextMode);
      if (nextMode === "Mesh" && options?.femDockTab) {
        setFemDockTab(options.femDockTab);
      }
    });
  }, [activateWorkspaceTab, currentStage, effectiveViewMode, setFemDockTab, setViewMode]);

  /* ── handleCompute ── */
  const handleCompute = useCallback(() => {
    void enqueueCommand({ kind: "solve" });
  }, [enqueueCommand]);

  /* ── openFemMeshWorkspace ── */
  const openFemMeshWorkspace = useCallback((tab: FemDockTab = "mesh") => {
    setFemDockTab(tab);
    transitionToViewMode("3D", {
      force: true,
    });
    if (meshRenderMode === "surface") {
      void patchDisplay(visualizationPatchForRenderMode("surface+edges"));
    }
  }, [meshRenderMode, patchDisplay, setFemDockTab, transitionToViewMode]);

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
      let changed = false;
      const nextScene: SceneDocument = {
        ...baseScene,
        revision: baseScene.revision + 1,
        objects: baseScene.objects.map((object) => {
          if (object.id !== geometryName && object.name !== geometryName) {
            return object;
          }
          changed = true;
          const translation = object.transform.translation ?? [0, 0, 0];
          return {
            ...object,
            tags: Array.from(new Set([...(object.tags ?? []), "mesh:dirty"])),
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
      return changed ? nextScene : baseScene;
    });
  }, [localBuilderDraft, setSceneDocument]);

  /* ── applyMeshWorkspacePreset ── */
  const applyMeshWorkspacePreset = useCallback((presetId: MeshWorkspacePresetId) => {
    const preset = MESH_WORKSPACE_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) return;

    transitionToViewMode(preset.viewMode, {
      force: true,
      femDockTab: preset.dockTab,
      beforeTransition: () => {
        if (preset.viewMode === "2D") {
          setComponent((prev) => (prev === "magnitude" ? "x" : prev));
        }
        setSelectedSidebarNodeId(
          preset.dockTab === "quality"
            ? "universe-mesh-quality"
            : preset.dockTab === "mesher"
              ? "universe-mesh-size"
              : preset.dockTab === "pipeline"
                ? "universe-mesh-pipeline"
                : "universe-mesh-view",
        );
      },
    });

    const renderPatch = visualizationPatchForRenderMode(preset.renderMode);
    const opacityPatch =
      preset.opacity != null ? visualizationPatchForOpacity(preset.opacity) : null;
    const clipPatch =
      preset.clipEnabled !== undefined
        ? visualizationPatchForClip({ enabled: preset.clipEnabled })
        : null;
    void patchDisplay({
      ...renderPatch,
      ...clipPatch,
      layers: {
        ...renderPatch.layers,
        ...opacityPatch?.layers,
      },
    });
  }, [
    setComponent,
    setSelectedSidebarNodeId,
    patchDisplay,
    transitionToViewMode,
  ]);

  /* ── handleViewModeChange ── */
  const handleViewModeChange = useCallback((mode: string) => {
    const normalizedMode = normalizeViewportMode(mode);
    if (!normalizedMode) {
      return;
    }
    if (normalizedMode === effectiveViewMode) {
      return;
    }
      if (normalizedMode === CHARTS_VIEW_MODE) {
      activateWorkspaceTab(currentStage, "core:charts");
      return;
    }
    if (normalizedMode === "Mesh") {
      transitionToViewMode("3D", { force: true });
      return;
    }
    transitionToViewMode(normalizedMode, {
      force: normalizedMode !== effectiveViewMode,
      beforeTransition: () => {
        if (normalizedMode === "2D") {
          setComponent((prev) => (prev === "magnitude" ? "x" : prev));
        }
      },
    });
  }, [
    activateWorkspaceTab,
    currentStage,
    effectiveViewMode,
    setComponent,
    transitionToViewMode,
  ]);

  const ensureAnalyzeViewMode = useCallback(() => {
    if (effectiveViewMode !== "Analyze") {
      setViewMode("Analyze");
    }
  }, [effectiveViewMode, setViewMode]);

  const ensureSceneSyncedBeforeComputeFields = useCallback(
    () =>
      syncSceneBeforeComputeFields({
        localScene: localBuilderDraft,
        remoteScene: remoteSceneDocument,
        liveApi,
        refreshLiveState,
        setSceneDocument,
        setCommandErrorMessage,
        setPreviewMessage,
        appendFrontendTrace,
      }),
    [
      appendFrontendTrace,
      liveApi,
      localBuilderDraft,
      refreshLiveState,
      remoteSceneDocument,
      setCommandErrorMessage,
      setPreviewMessage,
      setSceneDocument,
    ],
  );

  /* ── handleSimulationAction ── */
  const handleSimulationAction = useCallback((action: string) => {
    if (action === "compute_fields") {
      void (async () => {
        const sceneSynced = await ensureSceneSyncedBeforeComputeFields();
        if (!sceneSynced) {
          return;
        }

        const computeQuantity = resolveComputeFieldsQuantity({
          femDiscretization,
          selectedQuantity,
        });
        if (computeQuantity !== selectedQuantity) {
          setSelectedQuantity(computeQuantity);
          setPreviewMessage(
            `${selectedQuantity} is antenna-only in native FEM preview; computing ${computeQuantity} instead.`,
          );
          await patchDisplay({ active_quantity_id: computeQuantity });
        }

        await enqueueCommand({ kind: "compute_fields" });
      })().catch((error) => {
        setCommandErrorMessage(
          error instanceof Error
            ? `Compute fields failed before start: ${error.message}`
            : "Compute fields failed before start",
        );
      });
      return;
    }

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
        fixed_timestep: parseOptionalNumber(solverSettings.fixedTimestep),
        max_error: parseOptionalNumber(solverSettings.maxError),
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
    ensureSceneSyncedBeforeComputeFields,
    femDiscretization,
    handleCompute,
    patchDisplay,
    runUntilInput,
    selectedQuantity,
    solverSettings.fixedTimestep,
    solverSettings.integrator,
    solverSettings.energyTolerance,
    solverSettings.maxRelaxSteps,
    solverSettings.relaxAlgorithm,
    solverSettings.relaxAlpha,
    solverSettings.torqueTolerance,
    setCommandErrorMessage,
    setPreviewMessage,
    setSelectedQuantity,
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
      const profile = normalizeSessionExportProfile(format);
      const uiState = useWorkspaceStore.getState().exportUiStateSnapshot();
      const response = await liveApi.exportSession({
        profile,
        ui_state: uiState,
      });
      const fileName = sessionExportFileName(profile);
      downloadBase64File(fileName, response.fms_base64);
      setStateIoMessage(`Saved session as ${fileName} (${formatByteSize(response.size_bytes)})`);
    } catch (error) {
      setStateIoMessage(error instanceof Error ? error.message : "Failed to save session");
    } finally {
      setStateIoBusy(false);
    }
  }, [liveApi]);

  /* ── handleStateImport ── */
  const handleStateImport = useCallback(async (
    file: File,
    options?: {
      restoreMode?: string;
    },
  ) => {
    setStateIoBusy(true);
    setStateIoMessage(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const inspection = await liveApi.inspectSessionImport({
        fms_base64: contentBase64,
      });
      const response = await liveApi.commitSessionImport({
        fms_base64: contentBase64,
        restore_mode: options?.restoreMode,
      });
      if (response.ui_state !== undefined) {
        useWorkspaceStore.getState().importUiStateSnapshot(response.ui_state);
      }
      const warnings =
        response.warnings.length > 0
          ? response.warnings
          : inspection.inspection.warnings;
      const warningText =
        warnings.length > 0 ? ` Warnings: ${warnings.join("; ")}` : "";
      setStateIoMessage(
        `Opened session ${inspection.inspection.name} (${response.restore_class.replaceAll("_", " ")}).${warningText}`,
      );
    } catch (error) {
      setStateIoMessage(error instanceof Error ? error.message : "Failed to open session");
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
      if (!localBuilderDraft) {
        throw new Error("No scene document is available for script sync");
      }
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
    (workspaceStatus === "running" || workspaceStatus === "paused") &&
    runtimeCanAcceptCommands &&
    !commandBusy;
  const primaryRunAction =
    isWaitingForCompute ? "compute" : workspaceStatus === "paused" ? "resume" : "run";
  const primaryRunLabel =
    isWaitingForCompute ? "Compute" : workspaceStatus === "paused" ? "Resume" : "Run";

  /* ── requestDisplayQuantity ── */
  const requestDisplayQuantity = useCallback((nextQuantity: string) => {
    const cacheState = resolveQuantitySwitchCacheState({
      cachedFieldQuantities,
      nextQuantity,
      previewControlsActive,
    });
    recordFrontendPerfSample({
      scope: "QuantitySwitch",
      phase: "request",
      durationMs: 0,
      timestampMs: perfNow(),
      meta: {
        quantity: nextQuantity,
        cacheState,
        viewMode: effectiveViewMode,
        femDiscretization,
      },
    });
    startTransition(() => {
      if (femDiscretization && effectiveViewMode === "Mesh") handleViewModeChange("3D");
      setSelectedQuantity(nextQuantity);
    });
    if (shouldPatchDisplayForQuantitySwitch({ cacheState, previewControlsActive })) {
      const patchStartedAt = perfNow();
      void patchDisplay({ active_quantity_id: nextQuantity })
        .then(() => {
          recordFrontendPerfSample({
            scope: "QuantitySwitch",
            phase: "display-patch",
            durationMs: perfNow() - patchStartedAt,
            timestampMs: perfNow(),
            meta: {
              quantity: nextQuantity,
              cacheState,
              status: "ok",
            },
          });
        })
        .catch((error) => {
          recordFrontendPerfSample({
            scope: "QuantitySwitch",
            phase: "display-patch",
            durationMs: perfNow() - patchStartedAt,
            timestampMs: perfNow(),
            meta: {
              quantity: nextQuantity,
              cacheState,
              status: "error",
              reason: error instanceof Error ? error.message : String(error),
            },
          });
        });
    }
  }, [
    cachedFieldQuantities,
    effectiveViewMode,
    femDiscretization,
    patchDisplay,
    previewControlsActive,
  ]);

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
      const openedTabId = openWorkspaceTab(currentStage, {
        key: `result:${entry.id}`,
        id: `result-tab:${entry.id}`,
        kind: tabKind,
        title: entry.label,
        closable: true,
        pinned: entry.pinned,
        mountPolicy: "active-only",
        payload: {
          resultWorkspaceId: entry.id,
          quantityId: entry.quantityId ?? undefined,
        },
      });
      activateWorkspaceTab(currentStage, openedTabId);
      if (entry.kind === "spectrum") {
        ensureAnalyzeViewMode();
        openAnalyze({ tab: "spectrum", selectedModeIndex: null });
        return;
      }
      if (entry.kind === "dispersion") {
        ensureAnalyzeViewMode();
        openAnalyze({ tab: "dispersion", selectedModeIndex: null });
        return;
      }
      if (entry.kind === "modes") {
        ensureAnalyzeViewMode();
        openAnalyze({ tab: "modes" });
        return;
      }
      if (entry.kind === "time-traces") {
        ensureAnalyzeViewMode();
        openAnalyze({ domain: "vortex", tab: "time-traces" });
        return;
      }
      if (entry.kind === "vortex-frequency") {
        ensureAnalyzeViewMode();
        openAnalyze({ domain: "vortex", tab: "vortex-frequency" });
        return;
      }
      if (entry.kind === "vortex-trajectory") {
        ensureAnalyzeViewMode();
        openAnalyze({ domain: "vortex", tab: "vortex-trajectory" });
        return;
      }
      if (entry.kind === "vortex-orbit") {
        ensureAnalyzeViewMode();
        openAnalyze({ domain: "vortex", tab: "vortex-orbit" });
        return;
      }
      if (entry.kind === "table") {
        ensureAnalyzeViewMode();
        openAnalyze({ tab: "spectrum", selectedModeIndex: null });
        return;
      }
      if (entry.quantityId) {
        requestDisplayQuantity(entry.quantityId);
      }
      if (femDiscretization && effectiveViewMode === "Mesh") {
        handleViewModeChange("3D");
      }
    },
    [
      activateWorkspaceTab,
      currentStage,
      effectiveViewMode,
      ensureAnalyzeViewMode,
      femDiscretization,
      openAnalyze,
      openWorkspaceTab,
      requestDisplayQuantity,
      resultWorkspaceEntries,
      handleViewModeChange,
    ],
  );

  const openAnalyzeSurface = useCallback(
    (options: OpenAnalyzeSurfaceOptions = {}) => {
      if (options.resultWorkspaceId) {
        openResultWorkspaceEntry(options.resultWorkspaceId);
        return;
      }
      activateWorkspaceTab(currentStage, "core:analyze");
      ensureAnalyzeViewMode();
      if (options.selection) {
        openAnalyze(options.selection);
      }
    },
    [
      activateWorkspaceTab,
      currentStage,
      ensureAnalyzeViewMode,
      openAnalyze,
      openResultWorkspaceEntry,
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
    requestDisplayQuantity,
    requestPreviewQuantity: requestDisplayQuantity,
    openAnalyzeSurface,
    openResultWorkspaceEntry,
    renameResultWorkspaceEntry,
    removeResultWorkspaceEntry,
    duplicateResultWorkspaceEntry,
    setResultWorkspacePinned,
  };
}
