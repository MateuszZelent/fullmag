const FRONTEND_DIAGNOSTIC_FLAGS_STORAGE_KEY = "fullmag.frontend_diagnostic_flags.v1";

const DEFAULT_FRONTEND_DIAGNOSTIC_FLAGS = {
  workspace: {
    // "off" -> normal WorkspaceShell (no standalone diagnostic viewport)
    standaloneDiagnosticViewportMode: "off",
    enableGraphV2: true,
  },
  session: {
    enableLiveBootstrapFetch: true,
    enableLiveWebSocket: true,
  },
  shell: {
    useDockingShell: true,
    showRibbonBar: true,
    showSidebar: true,
    showViewportBar: true,
    showPreviewNotices: true,
    showBottomDock: true,
    showRightInspector: true,
    showStatusBar: true,
    showWorkspaceOverlays: true,
    showBackendErrorNotice: true,
    showLayoutDebugHud: false,
  },
  viewportRouting: {
    useMinimalViewportSelectionPath: false,
    enableGlobalScalarCard: true,
    enableGridScalar2D: true,
    enableFemMeshWorkspace: true,
    enableFem3D: true,
    enableFemSlice2D: true,
    enableFdm3D: true,
    enableFdmMeshWorkspace: true,
    enableFdmSlice2D: true,
    enableAnalyzeViewport: true,
    enableBoundsPreview: true,
  },
  viewportChrome: {
    showTelemetryHud: true,
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
    enableBridgeSync: true,
    forceDpr: null,
    frameloopMode: "always",
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
    forceViewportAlwaysRender: true,
    forceViewportControlsOn: true,
    forceViewportLightsOff: false,
  },
  femViewport: {
    // Performance switch:
    // false => max smoothness (no face picking on mouse)
    // true  => selection-only interaction mode (camera controls disabled, geometry picking enabled)
    enableSelectionOnlyInteractionMode: false,
    // Temporary escape hatch while we stabilize the full 3D viewport path.
    disableSimplifiedMode: true,
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
    showToolbar: true,
    showWarnings: true,
    showViewCube: true,
    showOrientationSphere: true,
    showFieldLegend: true,
    showSelectionHud: true,
    showPartExplorer: true,
    showCameraAutoFit: true,
    showClipPlanesHelper: true,
    showSceneGeometry: true,
    showPerPartGeometry: true,
    showAirGeometry: true,
    showMagneticGeometry: true,
    showSurfacePass: true,
    showSurfaceHiddenEdgesPass: true,
    showSurfaceVisibleEdgesPass: true,
    showVolumeHiddenEdgesPass: true,
    showVolumeVisibleEdgesPass: true,
    showPointsPass: true,
    airboxDisabledByDefault: true,
    enableGeometryCompaction: true,
    enableGeometryNormals: true,
    enableGeometryVertexColors: true,
    enableGeometryPointerInteractions: true,
    enableGeometryHoverInteractions: false,
    enableGeometryPerfLogging: false,
    showArrowLayer: true,
    showSelectionHighlight: true,
    showAntennaOverlays: true,
    showSceneAxes: true,
    showTextureTransformGizmo: true,
    showHoverTooltip: true,
    showContextMenu: true,
    showStatusBar: true,
  },
  fdmViewport: {
    showToolbar: true,
    showStatusChip: true,
    showViewCube: true,
    showOrientationSphere: true,
    showTextureModeToolbar: true,
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

export function loadFrontendDiagnosticFlagsFromStorage(): FrontendDiagnosticFlags {
  const defaults = getDefaultFrontendDiagnosticFlags();
  if (typeof window === "undefined") {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(FRONTEND_DIAGNOSTIC_FLAGS_STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as unknown;
    const merged = mergeKnownShape(defaults, parsed);
    const flags = merged as FrontendDiagnosticFlags;
    flags.workspace.enableGraphV2 = true;
    return flags;
  } catch {
    return defaults;
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
