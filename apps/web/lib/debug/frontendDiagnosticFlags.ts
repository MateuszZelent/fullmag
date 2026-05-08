const FRONTEND_DIAGNOSTIC_FLAGS_STORAGE_KEY = "fullmag.frontend_diagnostic_flags.v1";

const DEFAULT_FRONTEND_DIAGNOSTIC_FLAGS = {
  workspace: {
    // "off" -> normal WorkspaceShell (no standalone diagnostic viewport)
    standaloneDiagnosticViewportMode: "off",
    // Top-down isolation ladder for Workspace runtime crashes.
    // Keep false to hard-disable workspace tree, then re-enable layer-by-layer.
    enableWorkspaceTree: true,
    enableWorkspaceEntryPage: true,
    enableWorkspaceShell: true,
    enableRunControlRoom: true,
    enableControlRoomShell: true,
    enableWorkspaceDockingShell: true,
    enableDockCenterTabs: true,
    enableDockingTooltipProviders: true,
    enableGraphV2: true,
    enableWorkspaceGraphBridge: true,
  },
  dockCenterTabs: {
    // Internal master for DockCenterTabs submodules (workspace.enableDockCenterTabs stays external gate).
    enableInternalTree: true,
    // Effects
    enableAutoActivateEffect: true,
    enableEnsureChartsTabEffect: true,
    enableApplySelectionEffect: true,
    enableFeatureFlagsLoadingGate: true,
    // Shell/UI
    enableTooltipProvider: true,
    enableTabsShell: true,
    enableTabsHeader: true,
    enableInlineCloseButton: true,
    enableTabContent: true,
    showPreviewNotices: true,
    // Content modules
    enableChartsViewport: true,
    enableAnalyzeViewport: true,
    enableViewportCanvas: true,
    enablePinOverlayButton: true,
  },
  session: {
    enableLiveWebSocket: true,
  },
  leakIsolation: {
    enableHiddenViewportBridge: true,
    enableSessionDataPlaneBridge: true,
    enableScalarHydration: true,
    enableMeshTopologyHydration: true,
    enableDomainTopologyHydration: true,
    enableSharedDomainMeshTopologyHydration: true,
    enableSharedDomainMeshSummaryHydration: true,
    enableSharedDomainMeshManifestHydration: true,
    enableSharedDomainMeshTopologyFetch: true,
    enableSharedDomainMeshTopologyDecode: true,
    enableSharedDomainMeshStoreMerge: true,
    enableSharedDomainMeshStoreRead: true,
    enableSharedDomainMeshMergeWithExistingStoreMesh: true,
    enableSharedDomainMeshStoreFemMeshWrite: true,
    enableSharedDomainMeshStoreApply: true,
    enableControlRoomFemMeshConsumption: true,
    enableControlRoomFemMeshDomainLayoutInput: true,
    enableControlRoomFemMeshFieldDataInput: true,
    enableControlRoomFemMeshDerivedModelInput: true,
    enableControlRoomFemMeshContextPublish: true,
    enableViewportFemMeshView3DRender: true,
    enableViewportHostedFemMeshTabRender: true,
    enableViewportHostedFem3DRender: true,
    enableViewportMinimalFem3DRender: true,
    enableFemMeshView3DSceneRender: true,
    enableFemMeshView3DGeometryRender: true,
    enableFemMeshView3DArrowRender: true,
    enableFemMeshView3DOverlayRender: true,
    enableFemMeshView3DAutoFit: true,
    enableFemMeshView3DAutoFitGenerationEffect: true,
    enableFemMeshView3DBlankViewportRecovery: true,
    enableFemMeshView3DAutoFitComponent: true,
    enableFemMeshView3DAutoFitCameraApply: true,
    enableFemMeshView3DAutoFitInvalidate: true,
    enableFemMeshView3DAutoFitRecord: true,
    enableLegacyBinaryFemTopologyHydration: true,
    enableBinaryFieldHydration: true,
    enableIdleLiveStatusPolling: true,
  },
  shell: {
    useDockingShell: true,
    showRibbonBar: true,
    showSidebar: true,
    showViewportBar: false,
    showPreviewNotices: true,
    showBottomDock: true,
    showRightInspector: true,
    showStatusBar: false,
    showWorkspaceOverlays: true,
    showBackendErrorNotice: true,
    showLayoutDebugHud: false,
  },
  viewportRouting: {
    useMinimalViewportSelectionPath: false,
    enableUnifiedViewport3D: true,
    // Stage-0 safe baseline: start with renderer host only, then enable toolbar modules incrementally.
    enableUnifiedViewportToolbar: true,
    enableGlobalScalarCard: true,
    enableGridScalar2D: true,
    enableFemSlice2D: true,
    enableFdmSlice2D: true,
    enableAnalyzeViewport: true,
    enableBoundsPreview: true,
  },
  viewportChrome: {
    showTelemetryHud: false,
    showDataPlaneIndicator: true,
    showAntennaPreviewBadge: true,
    showFemSelectionBadges: true,
    showFdmSelectionBadges: true,
  },
  viewportCore: {
    useBareCanvasShell: false,
    useCanvasHostEventSource: true,
    enableViewportControls: true,
    enableViewportLights: true,
    enableControlDamping: true,
    enableCanvasPointerMissedHandler: true,
    enableCanvasContextMenuHandler: true,
    enableCanvasCreatedHandler: true,
    enableCanvasVisualActivityProbe: false,
    enableBridgeSync: true,
    forceDpr: 1,
    frameloopMode: "demand",
  },
  renderDebug: {
    enableRenderLogging: false,
  },
  magnetizationAuthoring: {
    enablePresetTextureBackendSync: true,
    showPresetTextureBackendSyncProgress: true,
    presetTextureBackendSyncDebounceMs: 220,
  },
  femWrapper: {
    enableInteractiveState: true,
    enablePartDerivedModel: true,
    enableVectorDerivedModel: true,
    enableBoundsDerivedModel: true,
    enableToolbarModel: true,
    enableOverlayItemsModel: true,
    enableOverlayManager: true,
    enableHoverTooltip: true,
    enableContextMenu: true,
    enableTextureTransformModel: true,
    enableTextureTransformGizmo: true,
    enableCameraFitEffect: true,
    enableScreenshotCapture: true,
    // keep FEM responsive under heavy React tree updates
    forceViewportAlwaysRender: false,
    forceViewportControlsOn: true,
    forceViewportLightsOff: false,
  },
  femViewport: {
    // Performance switch:
    // false => max smoothness (no face picking on mouse)
    // true  => selection-only interaction mode (camera controls disabled, geometry picking enabled)
    enableSelectionOnlyInteractionMode: false,
    // Temporary escape hatch while we stabilize the full 3D viewport path.
    disableSimplifiedMode: false,
    // Granular preset-reset flags: when switching render mode, reset individual
    // display concerns using the per-mode preset value.
    // The old monolithic flag is kept as a master override for backward compat.
    resetDisplayStateOnRenderModeChange: true,
    resetOpacityOnRenderModeChange: true,
    resetClipOnRenderModeChange: true,
    resetVectorDomainOnRenderModeChange: true,
    resetShrinkOnRenderModeChange: true,
    resetQualityOnRenderModeChange: true,
    forceWireframe: false,
    forceDisableClip: false,
    forceHideArrows: false,
    forceLowQualityProfile: false,
    showToolbar: false,
    showWarnings: true,
    showViewCube: true,
    // Orientation reference is shown automatically when orientation coloring is active.
    // This flag remains only as a diagnostic kill switch.
    showOrientationSphere: true,
    showFieldLegend: true,
    showSelectionHud: true,
    showPartExplorer: false,
    showCameraAutoFit: true,
    showClipPlanesHelper: false,
    showSceneGeometry: true,
    showPerPartGeometry: true,
    showAirGeometry: true,
    showMagneticGeometry: true,
    showSurfacePass: true,
    showSurfaceHiddenEdgesPass: false,
    showSurfaceVisibleEdgesPass: false,
    showVolumeHiddenEdgesPass: false,
    showVolumeVisibleEdgesPass: false,
    showPointsPass: true,
    airboxDisabledByDefault: true,
    enableGeometryCompaction: true,
    enableGeometryNormals: true,
    enableGeometryVertexColors: true,
    enableGeometryPointerInteractions: true,
    enableGeometryHoverInteractions: false,
    enableGeometryPerfLogging: false,
    enableGeometryRenderLogging: false,
    // Keep the layer available so the toolbar toggle can actually show vectors.
    // The arrows are still off by default at the viewport state level.
    showArrowLayer: true,
    showSelectionHighlight: true,
    showAntennaOverlays: true,
    showSceneAxes: true,
    showTextureTransformGizmo: true,
    showHoverTooltip: false,
    showContextMenu: true,
    showStatusBar: true,
  },
  vectorSurfaceViewport: {
    // Master gate for the VectorSurface 3D canvas branch.
    enableCanvas3D: true,
    // Toolbar shell + button modules.
    showToolbar: false,
    showStatusChip: false,
    enableRenderModeControls: false,
    enableColorControls: false,
    enableDisplayControls: false,
    enableTopographyControls: false,
    enableCameraControls: false,
    enableRotationDebugControls: false,
    enableInfoControls: false,
    enableSnapshotControl: false,
    // Overlay gizmos.
    showViewCube: true,
    showOrientationSphere: true,
    showLiveRenderDebugPanel: false,
    showTextureModeToolbar: false,
  },
  /**
   * Phased rollout flags for the FEM data-plane refactor (P7).
   * Each flag gates one deliverable. All default to the safe
   * (non-breaking) setting; flip in localStorage or dev panel.
   */
  dataPlaneRollout: {
    /** PR-4: Use FieldFrameEnvelope in session runtime store. */
    fieldFrameEnvelopeV1: true,
    /** PR-5: Binary field transport (format=bin). */
    binaryFieldTransport: true,
    /** PR-8: Binary FEM topology transport (mesh_transport=bin). */
    binaryFemTopologyTransport: true,
    /** PR-1/PR-2: Monotonic frame guard active. */
    monotonicFrameGuard: true,
    /** PR-6: Split topology / field caches in viewport. */
    viewportSplitTopologyFieldCache: false,
    /** PR-10: Route Control Room transport through resource-first status bridge. */
    resourceFirstSessionRuntime: true,
    /** PR-7: Semantic chart time series. */
    chartSemanticSeries: false,
    /** PR-7: Worker-based chart decimation. */
    chartWorkerDecimation: false,
    /** PR-8: Worker-based FEM 2D slice topology/field sampling. */
    femSliceWorkerSampling: false,
    /** P-06: Worker-based vertex color computation for large FEM meshes. */
    femVertexColorWorker: true,
    /** PR-1: Frontend diagnostics panel. */
    frontendDiagnosticsPanel: true,
  },
  /**
   * Interaction refactoring flags (P1–P7).
   * Gates the interaction trace bus and selection/focus separation.
   */
  interactions: {
    /** Enable the centralised interaction trace bus (dev-only console output). */
    trace: false,
    /** Show the dev-only interaction HUD overlay. */
    showHud: false,
  },
};

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends object
    ? T[K] extends null
      ? T[K]
      : DeepMutable<T[K]>
    : T[K];
};

export type FrontendDiagnosticFlags = DeepMutable<typeof DEFAULT_FRONTEND_DIAGNOSTIC_FLAGS>;

type JsonLike = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeKnownShape(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const next: JsonLike = {};
  for (const key of Object.keys(base)) {
    const baseValue = (base as JsonLike)[key];
    const overrideValue = (override as JsonLike)[key];
    if (overrideValue === undefined) {
      next[key] = deepClone(baseValue);
      continue;
    }
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      next[key] = mergeKnownShape(baseValue, overrideValue);
      continue;
    }
    next[key] = overrideValue;
  }
  return next;
}

function assignMutableDeep(target: unknown, source: unknown): void {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return;
  }
  for (const key of Object.keys(source)) {
    const sourceValue = (source as JsonLike)[key];
    const targetValue = (target as JsonLike)[key];
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      assignMutableDeep(targetValue, sourceValue);
      continue;
    }
    (target as JsonLike)[key] = deepClone(sourceValue);
  }
}

export function getDefaultFrontendDiagnosticFlags(): FrontendDiagnosticFlags {
  return deepClone(DEFAULT_FRONTEND_DIAGNOSTIC_FLAGS) as FrontendDiagnosticFlags;
}

function normalizeFrontendDiagnosticFlags(
  flags: FrontendDiagnosticFlags,
): FrontendDiagnosticFlags {
  const normalized = deepClone(flags) as FrontendDiagnosticFlags;
  normalized.workspace.standaloneDiagnosticViewportMode = "off";
  normalized.workspace.enableWorkspaceTree = true;
  normalized.workspace.enableWorkspaceEntryPage = true;
  normalized.workspace.enableWorkspaceShell = true;
  normalized.workspace.enableRunControlRoom = true;
  normalized.shell.showRibbonBar = true;
  normalized.shell.showViewportBar = false;
  normalized.viewportRouting.enableUnifiedViewportToolbar = true;
  normalized.femViewport.showToolbar = false;
  normalized.femViewport.showSurfacePass = true;
  normalized.femViewport.showPointsPass = true;
  normalized.vectorSurfaceViewport.showViewCube = true;
  return normalized;
}

export function loadFrontendDiagnosticFlagsFromStorage(): FrontendDiagnosticFlags {
  const defaults = getDefaultFrontendDiagnosticFlags();
  if (typeof window === "undefined") {
    return normalizeFrontendDiagnosticFlags(defaults);
  }
  try {
    const raw = window.localStorage.getItem(FRONTEND_DIAGNOSTIC_FLAGS_STORAGE_KEY);
    if (!raw) {
      return normalizeFrontendDiagnosticFlags(defaults);
    }
    const parsed = JSON.parse(raw) as unknown;
    const merged = mergeKnownShape(defaults, parsed);
    return normalizeFrontendDiagnosticFlags(merged as FrontendDiagnosticFlags);
  } catch {
    return normalizeFrontendDiagnosticFlags(defaults);
  }
}

export function persistFrontendDiagnosticFlags(flags: FrontendDiagnosticFlags): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    FRONTEND_DIAGNOSTIC_FLAGS_STORAGE_KEY,
    JSON.stringify(flags),
  );
}

export function clearPersistedFrontendDiagnosticFlags(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(FRONTEND_DIAGNOSTIC_FLAGS_STORAGE_KEY);
}

const initialFrontendFlags = loadFrontendDiagnosticFlagsFromStorage();

export const FRONTEND_DIAGNOSTIC_FLAGS: FrontendDiagnosticFlags = initialFrontendFlags;

export function applyFrontendDiagnosticFlags(nextFlags: FrontendDiagnosticFlags): void {
  assignMutableDeep(FRONTEND_DIAGNOSTIC_FLAGS as unknown, nextFlags as unknown);
}

export function resetFrontendDiagnosticFlags(): FrontendDiagnosticFlags {
  const defaults = getDefaultFrontendDiagnosticFlags();
  applyFrontendDiagnosticFlags(defaults);
  clearPersistedFrontendDiagnosticFlags();
  return defaults;
}
