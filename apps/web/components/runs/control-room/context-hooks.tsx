"use client";

/* ═══════════════════════════════════════════════════════════════════
 * SPLIT CONTEXT ARCHITECTURE
 *
 * The monolithic context is split into 4 focused domains to prevent
 * unnecessary re-renders. Each domain has its own React context and
 * useMemo, so telemetry ticks (~10×/s) don't re-render the sidebar.
 *
 * TransportContext — live telemetry (changes every SSE tick)
 * ViewportContext — viewport UI state (changes on user interaction)
 * CommandContext  — runtime/command state (changes on events)
 * ModelContext    — structural model data (changes rarely)
 *
 * ═══════════════════════════════════════════════════════════════════ */

import { createContext, useContext } from "react";
import type { GpuTelemetryDevice } from "../../../lib/liveApiClient";
import type {
  ArtifactEntry,
  BackendCapabilities,
  CommandStatus,
  EngineLogEntry,
  FemLiveMesh,
  LiveState,
  PreviewState,
  QuantityDescriptor,
  RunManifest,
  RuntimeStatusState,
  ScalarRow,
  MeshWorkspaceState,
  ScriptBuilderStageState,
  ScriptBuilderState,
  SessionManifest,
} from "../../../lib/useSessionStream";
import type {
  DomainFrameState,
  FemMeshPart,
  MeshEntityViewStateMap,
  ModelBuilderGraphV2,
  SceneDocument,
  VisualizationPreset,
  VisualizationPresetFdmState,
  VisualizationPresetRef,
  VisualizationPresetSource,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  StageExecutionState,
  ScriptBuilderUniverseState,
  StudyPipelineDocumentState,
} from "../../../lib/session/types";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import type { MeshOptionsState, MeshQualityData } from "@/lib/mesh/options";
import type {
  ClipAxis,
  FemColorField,
  FemMeshData,
  MeshSelectionSnapshot,
  RenderMode,
} from "../../preview/FemMeshView3D";
import type {
  AntennaOverlay,
  BuilderObjectOverlay,
  FemDockTab,
  FocusObjectRequest,
  ObjectViewMode,
  SlicePlane,
  VectorComponent,
  ViewportScope,
  ViewportMode,
} from "./shared";
import { computeMeshFaceDetail } from "./shared";
import type {
  ActivityInfo,
  BackendErrorInfo,
  FieldStats,
  MaterialSummary,
  MeshQualitySummary,
  PreviewOption,
  QuickPreviewTarget,
  SessionFooterData,
  SolverPlanSummary,
} from "./types";
import type { MeshWorkspacePresetId } from "./meshWorkspace";
import type { AnalyzeSelectionState, AnalyzeTab } from "./analyzeSelection";
import type { VisibleSubmeshSnapshot } from "./submeshSnapshot";
import type { ArrowVisibilityStatus } from "../../../features/viewport-fem/model/femArrowVisibility";
import type { WorkspaceTab, WorkspaceTabInput, WorkspaceMode as WorkspaceStageMode } from "@/lib/workspace/workspace-store";

/* ── Transport: high-frequency telemetry ── */
export interface TransportContextValue {
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  effectiveTorqueT: number;
  effectiveHEff: number;
  effectiveHDemag: number;
  effectiveEEx: number;
  effectiveEDemag: number;
  effectiveEExt: number;
  effectiveEAni: number;
  effectiveEDmi: number;
  effectiveETotal: number;
  elapsed: number;
  stepsPerSec: number;
  liveState: LiveState | null;
  effectiveLiveState: LiveState | null;
  scalarRows: ScalarRow[];
  scalarRowsTotal: number;
  dmDtSpark: number[];
  dtSpark: number[];
  eTotalSpark: number[];
  preview: PreviewState | null;
  selectedVectors: Float64Array | null;
  fieldStats: FieldStats | null;
  hasSolverTelemetry: boolean;
}

/* ── Viewport: user-driven UI state ── */
export type WorkspaceMode = "build" | "study" | "analyze";
export type ResultWorkspaceKind =
  | "spectrum"
  | "dispersion"
  | "modes"
  | "time-traces"
  | "vortex-frequency"
  | "vortex-trajectory"
  | "vortex-orbit"
  | "quantity"
  | "table";

export interface ResultWorkspaceEntry {
  id: string;
  key: string;
  kind: ResultWorkspaceKind;
  label: string;
  quantityId: string | null;
  icon: string;
  badge: string | null;
  pinned: boolean;
  createdAtUnixMs: number;
}

export interface ViewportContextValue {
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (v: WorkspaceMode | ((prev: WorkspaceMode) => WorkspaceMode)) => void;
  viewMode: ViewportMode;
  effectiveViewMode: ViewportMode;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  selectedQuantity: string;
  consoleCollapsed: boolean;
  sidebarCollapsed: boolean;
  quantityOptions: PreviewOption[];
  previewQuantityOptions: PreviewOption[];
  quantityDescriptor: QuantityDescriptor | null;
  isVectorQuantity: boolean;
  quickPreviewTargets: QuickPreviewTarget[];
  selectedScalarValue: number | null;
  selectedQuantityLabel: string;
  selectedQuantityUnit: string | null;
  solverGrid: [number, number, number];
  previewGrid: [number, number, number];
  totalCells: number | null;
  activeCells: number | null;
  inactiveCells: number | null;
  activeMaskPresent: boolean;
  activeMask: boolean[] | null;
  maxSliceCount: number;
  effectiveVectorComponent: VectorComponent;
  emptyStateMessage: { title: string; description: string };
  previewBusy: boolean;
  previewMessage: string | null;
  previewControlsActive: boolean;
  requestedPreviewQuantity: string;
  requestedPreviewComponent: string;
  requestedPreviewLayer: number;
  requestedPreviewAllLayers: boolean;
  requestedPreviewEveryN: number;
  requestedPreviewXChosenSize: number;
  requestedPreviewYChosenSize: number;
  requestedPreviewAutoScale: boolean;
  requestedPreviewMaxPoints: number;
  previewEveryNOptions: number[];
  previewMaxPointOptions: number[];
  previewIsStale: boolean;
  previewIsBootstrapStale: boolean;
  /* Actions */
  setViewMode: React.Dispatch<React.SetStateAction<ViewportMode>>;
  setComponent: React.Dispatch<React.SetStateAction<VectorComponent>>;
  setPlane: React.Dispatch<React.SetStateAction<SlicePlane>>;
  setSliceIndex: React.Dispatch<React.SetStateAction<number>>;
  setSelectedQuantity: React.Dispatch<React.SetStateAction<string>>;
  setConsoleCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  handleViewModeChange: (mode: string) => void;
  handleCapture: () => void;
  handleExport: () => void;
  requestPreviewQuantity: (nextQuantity: string) => void;
}

/* ── Command: runtime & command state ── */
export interface CommandContextValue {
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  session: SessionManifest | null;
  run: RunManifest | null;
  capabilities: BackendCapabilities | null;
  metadata: Record<string, unknown> | null;
  engineLog: EngineLogEntry[];
  quantities: QuantityDescriptor[];
  artifacts: ArtifactEntry[];
  workspaceStatus: string;
  isWaitingForCompute: boolean;
  solverNotStartedMessage: string;
  isFemBackend: boolean;
  runtimeEngineLabel: string | null;
  runtimeEngineGpuLabel: string | null;
  runtimeEngineGpuDevice: GpuTelemetryDevice | null;
  activity: ActivityInfo;
  sessionFooter: SessionFooterData;
  runtimeStatus: RuntimeStatusState | null;
  stageExecution: StageExecutionState | null;
  runtimeCanAcceptCommands: boolean;
  commandStatus: CommandStatus | null;
  activeCommandKind: string | null;
  activeCommandState: CommandStatus["state"] | null;
  canRunCommand: boolean;
  canRelaxCommand: boolean;
  canPauseCommand: boolean;
  canStopCommand: boolean;
  canSkipCommand: boolean;
  primaryRunAction: string;
  primaryRunLabel: string;
  interactiveEnabled: boolean;
  interactiveControlsEnabled: boolean;
  awaitingCommand: boolean;
  commandBusy: boolean;
  commandMessage: string | null;
  latestBackendError: BackendErrorInfo | null;
  scriptSyncBusy: boolean;
  scriptSyncMessage: string | null;
  stateIoBusy: boolean;
  stateIoMessage: string | null;
  scriptInitialState: ScriptBuilderState["initial_state"];
  scriptBuilderGeometries: ScriptBuilderGeometryEntry[];
  scriptBuilderCurrentModules: ScriptBuilderCurrentModuleEntry[];
  scriptBuilderExcitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null;
  runUntilInput: string;
  /* Actions */
  setRunUntilInput: React.Dispatch<React.SetStateAction<string>>;
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  handleCompute: () => void;
  handleSimulationAction: (action: string) => void;
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
}

/* ── Model: structural/static model data ── */
export interface ModelContextValue {
  sceneDocument: SceneDocument | null;
  modelBuilderGraph: ModelBuilderGraphV2 | null;
  requestedRuntimeSelection: {
    requested_backend: string;
    requested_device: string;
    requested_precision: string;
    requested_mode: string;
    requested_cpu_threads: number | null;
  };
  material: MaterialSummary | null;
  solverPlan: SolverPlanSummary | null;
  solverSettings: SolverSettingsState;
  studyStages: ScriptBuilderStageState[];
  studyPipeline: StudyPipelineDocumentState | null;
  scriptBuilderDemagRealization: string | null;
  scriptBuilderUniverse: ScriptBuilderUniverseState | null;
  scriptBuilderGeometries: ScriptBuilderGeometryEntry[];
  scriptBuilderCurrentModules: ScriptBuilderCurrentModuleEntry[];
  scriptBuilderExcitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null;
  antennaOverlays: AntennaOverlay[];
  objectOverlays: BuilderObjectOverlay[];
  femMesh: FemLiveMesh | null;
  meshRenderMode: RenderMode;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: ClipAxis;
  meshClipPos: number;
  meshShowArrows: boolean;
  femArrowColorMode: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
  femArrowMonoColor: string;
  femArrowAlpha: number;
  femArrowLengthScale: number;
  femArrowThickness: number;
  femVectorDomainFilter: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
  femFerromagnetVisibilityMode: "hide" | "ghost";
  fdmVisualizationSettings: VisualizationPresetFdmState;
  visualizationProjectPresets: VisualizationPreset[];
  visualizationLocalPresets: VisualizationPreset[];
  activeVisualizationPresetRef: VisualizationPresetRef | null;
  meshSelection: MeshSelectionSnapshot;
  meshOptions: MeshOptionsState;
  meshQualityData: MeshQualityData | null;
  meshGenerating: boolean;
  femDockTab: FemDockTab;
  effectiveFemMesh: FemLiveMesh | null;
  femMeshData: FemMeshData | null;
  femTopologyKey: string | null;
  femColorField: FemColorField;
  femMagnetization3DActive: boolean;
  femShouldShowArrows: boolean;
  arrowVisibility: ArrowVisibilityStatus;
  isMeshWorkspaceView: boolean;
  meshFaceDetail: ReturnType<typeof computeMeshFaceDetail>;
  meshQualitySummary: MeshQualitySummary | null;
  meshWorkspace: MeshWorkspaceState | null;
  meshConfigDirty: boolean;
  meshConfigSignature: string | null;
  lastBuiltMeshConfigSignature: string | null;
  meshName: string | null;
  meshSource: string | null;
  meshExtent: [number, number, number] | null;
  meshBoundsMin: [number, number, number] | null;
  meshBoundsMax: [number, number, number] | null;
  meshFeOrder: number | null;
  domainFrame: DomainFrameState | null;
  worldExtent: [number, number, number] | null;
  worldCenter: [number, number, number] | null;
  worldExtentSource: string | null;
  meshHmax: number | null;
  mesherBackend: string | null;
  mesherSourceKind: string | null;
  mesherCurrentSettings: Record<string, unknown> | null;
  meshWorkspacePreset: MeshWorkspacePresetId;
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  viewportScope: ViewportScope;
  focusObjectRequest: FocusObjectRequest | null;
  objectViewMode: ObjectViewMode;
  activeTransformScope: "object" | "texture" | null;
  airMeshVisible: boolean;
  airMeshOpacity: number;
  meshEntityViewState: MeshEntityViewStateMap;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  meshParts: FemMeshPart[];
  visibleMeshPartIds: string[];
  visibleMagneticObjectIds: string[];
  visibleSubmeshSnapshot: VisibleSubmeshSnapshot | null;
  selectedMeshPart: FemMeshPart | null;
  focusedMeshPart: FemMeshPart | null;
  magneticParts: FemMeshPart[];
  airPart: FemMeshPart | null;
  interfaceParts: FemMeshPart[];
  analyzeSelection: AnalyzeSelectionState;
  resultWorkspaceEntries: ResultWorkspaceEntry[];
  activeResultWorkspaceId: string | null;
  workspaceTabs: WorkspaceTab[];
  activeWorkspaceTabId: string | null;
  /* Actions */
  setSolverSettings: React.Dispatch<React.SetStateAction<SolverSettingsState>>;
  setSceneDocument: React.Dispatch<React.SetStateAction<SceneDocument | null>>;
  setRequestedRuntimeSelection: React.Dispatch<
    React.SetStateAction<{
      requested_backend: string;
      requested_device: string;
      requested_precision: string;
      requested_mode: string;
      requested_cpu_threads: number | null;
    }>
  >;
  setStudyStages: React.Dispatch<React.SetStateAction<ScriptBuilderStageState[]>>;
  setStudyPipeline: React.Dispatch<React.SetStateAction<StudyPipelineDocumentState | null>>;
  setScriptBuilderDemagRealization: React.Dispatch<React.SetStateAction<string | null>>;
  setScriptBuilderUniverse: React.Dispatch<React.SetStateAction<ScriptBuilderUniverseState | null>>;
  setScriptBuilderGeometries: React.Dispatch<React.SetStateAction<ScriptBuilderGeometryEntry[]>>;
  setScriptBuilderCurrentModules: React.Dispatch<
    React.SetStateAction<ScriptBuilderCurrentModuleEntry[]>
  >;
  setScriptBuilderExcitationAnalysis: React.Dispatch<
    React.SetStateAction<ScriptBuilderExcitationAnalysisEntry | null>
  >;
  setMeshRenderMode: React.Dispatch<React.SetStateAction<RenderMode>>;
  setMeshOpacity: React.Dispatch<React.SetStateAction<number>>;
  setMeshClipEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setMeshClipAxis: React.Dispatch<React.SetStateAction<ClipAxis>>;
  setMeshClipPos: React.Dispatch<React.SetStateAction<number>>;
  setMeshShowArrows: React.Dispatch<React.SetStateAction<boolean>>;
  setFemArrowColorMode: React.Dispatch<
    React.SetStateAction<"orientation" | "x" | "y" | "z" | "magnitude" | "monochrome">
  >;
  setFemArrowMonoColor: React.Dispatch<React.SetStateAction<string>>;
  setFemArrowAlpha: React.Dispatch<React.SetStateAction<number>>;
  setFemArrowLengthScale: React.Dispatch<React.SetStateAction<number>>;
  setFemArrowThickness: React.Dispatch<React.SetStateAction<number>>;
  setFemVectorDomainFilter: React.Dispatch<
    React.SetStateAction<"auto" | "magnetic_only" | "full_domain" | "airbox_only">
  >;
  setFemFerromagnetVisibilityMode: React.Dispatch<React.SetStateAction<"hide" | "ghost">>;
  setFdmVisualizationSettings: React.Dispatch<
    React.SetStateAction<VisualizationPresetFdmState>
  >;
  setMeshSelection: React.Dispatch<React.SetStateAction<MeshSelectionSnapshot>>;
  setMeshOptions: React.Dispatch<React.SetStateAction<MeshOptionsState>>;
  setFemDockTab: React.Dispatch<React.SetStateAction<FemDockTab>>;
  setSelectedSidebarNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedObjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setViewportScope: React.Dispatch<React.SetStateAction<ViewportScope>>;
  setObjectViewMode: React.Dispatch<React.SetStateAction<ObjectViewMode>>;
  setActiveTransformScope: React.Dispatch<React.SetStateAction<"object" | "texture" | null>>;
  setAirMeshVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setAirMeshOpacity: React.Dispatch<React.SetStateAction<number>>;
  setMeshEntityViewState: React.Dispatch<React.SetStateAction<MeshEntityViewStateMap>>;
  setVisibleSubmeshSnapshot: React.Dispatch<
    React.SetStateAction<VisibleSubmeshSnapshot | null>
  >;
  setSelectedEntityId: (id: string | null) => void;
  setFocusedEntityId: (id: string | null) => void;
  setAnalyzeSelection: React.Dispatch<React.SetStateAction<AnalyzeSelectionState>>;
  openAnalyze: (next?: Partial<AnalyzeSelectionState>) => void;
  selectAnalyzeTab: (tab: AnalyzeTab) => void;
  selectAnalyzeMode: (index: number | null) => void;
  refreshAnalyze: () => void;
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
  openResultWorkspaceEntry: (id: string) => void;
  renameResultWorkspaceEntry: (id: string, label: string) => void;
  removeResultWorkspaceEntry: (id: string) => void;
  duplicateResultWorkspaceEntry: (id: string) => string | null;
  setResultWorkspacePinned: (id: string, pinned: boolean) => void;
  openWorkspaceTab: (stage: WorkspaceStageMode, tab: WorkspaceTabInput) => string;
  activateWorkspaceTab: (stage: WorkspaceStageMode, tabId: string | null) => void;
  closeWorkspaceTab: (stage: WorkspaceStageMode, tabId: string) => void;
  pinWorkspaceTab: (stage: WorkspaceStageMode, tabId: string, pinned: boolean) => void;
  requestFocusObject: (objectId: string) => void;
  handleStudyDomainMeshGenerate: (meshReason?: string) => Promise<void>;
  handleAirboxMeshGenerate: () => Promise<void>;
  handleObjectMeshOverrideRebuild: (objectId?: string | null) => Promise<void>;
  handleLassoRefine: (faceIndices: number[], factor: number) => Promise<void>;
  openFemMeshWorkspace: (tab?: FemDockTab) => void;
  applyMeshWorkspacePreset: (presetId: MeshWorkspacePresetId) => void;
  createVisualizationPreset: (source?: VisualizationPresetSource) => VisualizationPresetRef;
  setActiveVisualizationPresetRef: React.Dispatch<
    React.SetStateAction<VisualizationPresetRef | null>
  >;
  applyVisualizationPreset: (ref: VisualizationPresetRef, options?: { scopePartIds?: string[] }) => void;
  renameVisualizationPreset: (ref: VisualizationPresetRef, name: string) => void;
  duplicateVisualizationPreset: (
    ref: VisualizationPresetRef,
    targetSource?: VisualizationPresetSource,
  ) => VisualizationPresetRef | null;
  deleteVisualizationPreset: (ref: VisualizationPresetRef) => void;
  copyVisualizationPresetToSource: (
    ref: VisualizationPresetRef,
    targetSource: VisualizationPresetSource,
  ) => VisualizationPresetRef | null;
  updateVisualizationPreset: (
    ref: VisualizationPresetRef,
    update: (preset: VisualizationPreset) => VisualizationPreset,
  ) => void;
  applyAntennaTranslation: (moduleName: string, dx: number, dy: number, dz: number) => void;
  applyGeometryTranslation: (geometryName: string, dx: number, dy: number, dz: number) => void;
  resetViewportDisplayState: () => void;
}

/* ── React contexts ── */
export const TransportCtx = createContext<TransportContextValue | null>(null);
export const ViewportCtx = createContext<ViewportContextValue | null>(null);
export const CommandCtx = createContext<CommandContextValue | null>(null);
export const ModelCtx = createContext<ModelContextValue | null>(null);

/* ── Granular hooks (new API) ── */
export function useTransport(): TransportContextValue {
  const ctx = useContext(TransportCtx);
  if (!ctx) throw new Error("useTransport must be used within <ControlRoomProvider>");
  return ctx;
}

export function useViewport(): ViewportContextValue {
  const ctx = useContext(ViewportCtx);
  if (!ctx) throw new Error("useViewport must be used within <ControlRoomProvider>");
  return ctx;
}

export function useCommand(): CommandContextValue {
  const ctx = useContext(CommandCtx);
  if (!ctx) throw new Error("useCommand must be used within <ControlRoomProvider>");
  return ctx;
}

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelCtx);
  if (!ctx) throw new Error("useModel must be used within <ControlRoomProvider>");
  return ctx;
}
