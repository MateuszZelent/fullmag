import type {
  Viewport3DAuthoringModel,
  Viewport3DCapabilities,
  Viewport3DFdmModulePatch,
  Viewport3DFdmModuleState,
  Viewport3DModel,
  Viewport3DToolbarState,
  Viewport3DRenderMode,
  Viewport3DDiscretization,
  Viewport3DObjectViewMode,
  Viewport3DVectorFieldModel,
} from "./viewport3dContracts";
import {
  EMPTY_VIEWPORT3D_VECTOR_FIELD,
} from "./viewport3dContracts";
import {
  createViewport3DToolbarState,
} from "./viewport3dToolbarReducer";
import type {
  UnifiedRenderState,
  FemViewportLayerState,
} from "./unifiedViewportTypes";

function toViewport3DRenderMode(
  mode: UnifiedRenderState["meshRenderMode"],
): Viewport3DRenderMode {
  if (mode === "wireframe" || mode === "points" || mode === "mesh") {
    return mode;
  }
  if (mode === "solid+wireframe") {
    return "shaded+wireframe";
  }
  return "shaded";
}

function fromViewport3DRenderMode(
  mode: Viewport3DRenderMode,
): NonNullable<UnifiedRenderState["meshRenderMode"]> {
  if (mode === "wireframe" || mode === "points" || mode === "mesh") {
    return mode;
  }
  if (mode === "shaded+wireframe") {
    return "solid+wireframe";
  }
  return "solid";
}

function coalesceLayers(layers?: FemViewportLayerState): FemViewportLayerState {
  return {
    showPrimitives: layers?.showPrimitives ?? true,
    showMesh: layers?.showMesh ?? false,
    showMagneticTexture: layers?.showMagneticTexture ?? true,
    showQuantity: layers?.showQuantity ?? true,
  };
}

export interface LegacyToolbarBridgeInput {
  renderState: UnifiedRenderState;
  quantityId: string | null;
  clipFlip: boolean;
  interactionMode: Viewport3DToolbarState["rowB"]["interactionMode"];
  snapEnabled: boolean;
  objectViewMode: Viewport3DObjectViewMode;
  vectorsVisible: boolean;
  legendVisible: boolean;
  partExplorerVisible: boolean;
  projection: Viewport3DToolbarState["rowB"]["projection"];
  navProfile: Viewport3DToolbarState["rowB"]["navProfile"];
  popovers?: Partial<Viewport3DToolbarState["popovers"]>;
}

export function buildToolbarStateFromLegacy({
  renderState,
  quantityId,
  clipFlip,
  interactionMode,
  snapEnabled,
  objectViewMode,
  vectorsVisible,
  legendVisible,
  partExplorerVisible,
  projection,
  navProfile,
  popovers,
}: LegacyToolbarBridgeInput): Viewport3DToolbarState {
  const layers = coalesceLayers(renderState.femLayers);
  return createViewport3DToolbarState({
    rowA: {
      quantity: quantityId,
      component: renderState.vectorComponent,
      everyN: renderState.everyN,
      colormap: renderState.colorScale,
      autoScale: renderState.autoScale,
      showPrimitives: layers.showPrimitives,
      showMesh: layers.showMesh,
      showMagneticTexture: layers.showMagneticTexture,
      showQuantity: layers.showQuantity,
      renderMode: toViewport3DRenderMode(renderState.meshRenderMode),
      opacity: renderState.meshOpacity ?? 100,
      clipEnabled: Boolean(renderState.clipEnabled),
      clipAxis: renderState.clipAxis ?? "z",
      clipPosition: renderState.clipPosition ?? 50,
      clipFlip: clipFlip ? -1 : 1,
    },
    rowB: {
      interactionMode,
      snapEnabled,
      objectView: objectViewMode,
      vectorsVisible,
      legendVisible,
      partExplorerVisible,
      projection,
      navProfile,
    },
    popovers,
  });
}

export function applyToolbarStateToLegacyRenderState(
  toolbarState: Viewport3DToolbarState,
  previous: UnifiedRenderState,
): {
  renderState: UnifiedRenderState;
  clipFlip: boolean;
} {
  const next: UnifiedRenderState = {
    ...previous,
    vectorComponent: toolbarState.rowA.component,
    everyN: toolbarState.rowA.everyN,
    colorScale: toolbarState.rowA.colormap,
    autoScale: toolbarState.rowA.autoScale,
    meshRenderMode: fromViewport3DRenderMode(toolbarState.rowA.renderMode),
    meshOpacity: toolbarState.rowA.opacity,
    clipEnabled: toolbarState.rowA.clipEnabled,
    clipAxis: toolbarState.rowA.clipAxis,
    clipPosition: toolbarState.rowA.clipPosition,
    femLayers: {
      showPrimitives: toolbarState.rowA.showPrimitives,
      showMesh: toolbarState.rowA.showMesh,
      showMagneticTexture: toolbarState.rowA.showMagneticTexture,
      showQuantity: toolbarState.rowA.showQuantity,
    },
  };
  return {
    renderState: next,
    clipFlip: toolbarState.rowA.clipFlip < 0,
  };
}

export interface Viewport3DFdmSettingsInput {
  quality: "low" | "high" | "ultra";
  render_mode: "glyph" | "voxel";
  voxel_color_mode: "orientation" | "x" | "y" | "z";
  sampling: 1 | 2 | 4;
  brightness: number;
  voxel_opacity: number;
  voxel_gap: number;
  voxel_threshold: number;
  topo_enabled: boolean;
  topo_component: "x" | "y" | "z";
  topo_multiplier: number;
}

const DEFAULT_FDM_SETTINGS: Viewport3DFdmSettingsInput = {
  quality: "high",
  render_mode: "glyph",
  voxel_color_mode: "orientation",
  sampling: 1,
  brightness: 1.5,
  voxel_opacity: 0.5,
  voxel_gap: 0.14,
  voxel_threshold: 0.08,
  topo_enabled: false,
  topo_component: "z",
  topo_multiplier: 5,
};

export function mapFdmSettingsToViewport3DState(
  settings: Viewport3DFdmSettingsInput,
  vectorsVisible: boolean,
): Viewport3DFdmModuleState {
  return {
    quality: settings.quality,
    renderMode: settings.render_mode,
    voxelColorMode: settings.voxel_color_mode,
    sampling: settings.sampling,
    brightness: settings.brightness,
    voxelOpacity: settings.voxel_opacity,
    voxelGap: settings.voxel_gap,
    voxelThreshold: settings.voxel_threshold,
    vectorsVisible: settings.render_mode === "glyph" ? vectorsVisible : false,
    topography: {
      enabled: settings.topo_enabled,
      component: settings.topo_component,
      amplitude: settings.topo_multiplier,
    },
  };
}

export function mapViewport3DFdmPatchToLegacySettingsPatch(
  patch: Viewport3DFdmModulePatch,
): Partial<Viewport3DFdmSettingsInput> {
  const next: Partial<Viewport3DFdmSettingsInput> = {};
  if (patch.quality !== undefined) {
    next.quality = patch.quality;
  }
  if (patch.renderMode !== undefined) {
    next.render_mode = patch.renderMode;
  }
  if (patch.voxelColorMode !== undefined) {
    next.voxel_color_mode = patch.voxelColorMode;
  }
  if (patch.sampling !== undefined) {
    next.sampling = patch.sampling;
  }
  if (patch.brightness !== undefined) {
    next.brightness = patch.brightness;
  }
  if (patch.voxelOpacity !== undefined) {
    next.voxel_opacity = patch.voxelOpacity;
  }
  if (patch.voxelGap !== undefined) {
    next.voxel_gap = patch.voxelGap;
  }
  if (patch.voxelThreshold !== undefined) {
    next.voxel_threshold = patch.voxelThreshold;
  }
  if (patch.topography?.enabled !== undefined) {
    next.topo_enabled = patch.topography.enabled;
  }
  if (patch.topography?.component !== undefined) {
    next.topo_component = patch.topography.component;
  }
  if (patch.topography?.amplitude !== undefined) {
    next.topo_multiplier = patch.topography.amplitude;
  }
  return next;
}

export function resolveViewport3DOrientationReferenceVisible(args: {
  fdm: Viewport3DFdmModuleState | null;
  vectorField: Viewport3DVectorFieldModel | null;
}): boolean {
  const fdm = args.fdm;
  if (fdm == null) {
    return false;
  }
  if (fdm.renderMode === "voxel") {
    return fdm.voxelColorMode === "orientation";
  }
  return fdm.renderMode === "glyph" && fdm.vectorsVisible;
}

export interface Viewport3DModelAdapterInput {
  discretization: Viewport3DDiscretization;
  renderState: UnifiedRenderState;
  toolbarState: Viewport3DToolbarState;
  capabilities: Viewport3DCapabilities;
  worldExtent?: [number, number, number] | null;
  worldCenter?: [number, number, number] | null;
  topologyRevision?: string | null;
  fieldRevision?: string | null;
  quantityId?: string | null;
  selectedObjectId?: string | null;
  selectedEntityId?: string | null;
  focusedEntityId?: string | null;
  selectedSidebarNodeId?: string | null;
  loading?: boolean;
  message?: string | null;
  error?: string | null;
  pendingMeshBuild?: boolean;
  sourceKind?: "authored" | "preview" | "live" | "none";
  fieldDataRevision?: string | null;
  fieldDataTimestamp?: number | null;
  effectiveStep?: number | null;
  authoring?: Viewport3DAuthoringModel | null;
  fdmSettings?: Viewport3DFdmSettingsInput | null;
  fdmVectorsVisible?: boolean;
  vectorField?: Viewport3DVectorFieldModel | null;
}

export function buildViewport3DModelFromAdapter({
  discretization,
  renderState,
  toolbarState,
  capabilities,
  worldExtent = null,
  worldCenter = null,
  topologyRevision = null,
  fieldRevision = null,
  quantityId = null,
  selectedObjectId = null,
  selectedEntityId = null,
  focusedEntityId = null,
  selectedSidebarNodeId = null,
  loading = false,
  message = null,
  error = null,
  pendingMeshBuild = false,
  sourceKind = "none",
  fieldDataRevision = null,
  fieldDataTimestamp = null,
  effectiveStep = null,
  authoring = null,
  fdmSettings = null,
  fdmVectorsVisible = toolbarState.rowB.vectorsVisible,
  vectorField = null,
}: Viewport3DModelAdapterInput): Viewport3DModel {
  const resolvedFdmSettings =
    fdmSettings ?? (discretization !== "fem" ? DEFAULT_FDM_SETTINGS : null);
  const fdmState = resolvedFdmSettings
    ? mapFdmSettingsToViewport3DState(resolvedFdmSettings, fdmVectorsVisible)
    : null;
  const resolvedVectorField = vectorField ?? EMPTY_VIEWPORT3D_VECTOR_FIELD;
  return {
    scene: {
      discretization,
      layerVisibility: {
        showPrimitives: toolbarState.rowA.showPrimitives,
        showMesh: toolbarState.rowA.showMesh,
        showMagneticTexture: toolbarState.rowA.showMagneticTexture,
        showQuantity: toolbarState.rowA.showQuantity,
      },
      selectedLayer: renderState.selectedLayer,
      allLayersVisible: renderState.allLayersVisible,
      renderMode: toolbarState.rowA.renderMode,
      opacity: toolbarState.rowA.opacity,
      worldExtent,
      worldCenter,
      topologyRevision,
      fieldRevision,
      fallbackMode:
        capabilities.preview3d.enabled || !toolbarState.rowA.showPrimitives
          ? "none"
          : "bounds-preview",
    },
    quantity: {
      quantityId,
      component: toolbarState.rowA.component,
      everyN: toolbarState.rowA.everyN,
      colormap: toolbarState.rowA.colormap,
      autoScale: toolbarState.rowA.autoScale,
    },
    overlays: {
      viewCubeVisible: true,
      legendVisible: toolbarState.rowB.legendVisible,
      orientationReferenceVisible: resolveViewport3DOrientationReferenceVisible({
        fdm: fdmState,
        vectorField: resolvedVectorField,
      }),
      statusChipsVisible: true,
      selectionHudVisible: true,
      partExplorerVisible: toolbarState.rowB.partExplorerVisible,
    },
    selection: {
      selectedObjectId,
      selectedEntityId,
      focusedEntityId,
      selectedSidebarNodeId,
      objectViewMode: toolbarState.rowB.objectView,
    },
    camera: {
      projection: toolbarState.rowB.projection,
      navigation: toolbarState.rowB.navProfile,
      lastPreset: null,
    },
    clip: {
      enabled: toolbarState.rowA.clipEnabled,
      axis: toolbarState.rowA.clipAxis,
      position: toolbarState.rowA.clipPosition,
      flip: toolbarState.rowA.clipFlip,
    },
    status: {
      loading,
      message,
      error,
      pendingMeshBuild,
    },
    debug: {
      rotationDebugOpen: toolbarState.popovers.rotationDebug,
      liveRenderDebugOpen: toolbarState.popovers.liveRenderDebug,
      sourceKind,
      fieldDataRevision,
      fieldDataTimestamp,
      effectiveStep,
    },
    authoring,
    fdm: fdmState,
    vectorField: resolvedVectorField,
  };
}
