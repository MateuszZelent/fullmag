/**
 * Canonical contracts for the unified 3D viewport program.
 *
 * These types are intentionally backend-agnostic and describe the final
 * shared model for FEM, FDM, and primitives authoring.
 */

export type Viewport3DDiscretization = "fem" | "fdm" | "mixed";

export type Viewport3DComponent = "3D" | "x" | "y" | "z" | "|v|";
export type Viewport3DRenderMode =
  | "shaded"
  | "wireframe"
  | "shaded+wireframe"
  | "points";
export type Viewport3DInteractionMode =
  | "camera"
  | "select"
  | "move"
  | "rotate"
  | "scale";
export type Viewport3DProjectionMode = "perspective" | "orthographic";
export type Viewport3DNavigationProfile = "trackball" | "cad";
export type Viewport3DClipAxis = "x" | "y" | "z";
export type Viewport3DObjectViewMode = "context" | "isolate";
export type Viewport3DControlState =
  | "active"
  | "inactive"
  | "disabled"
  | "mixed"
  | "loading";
export type Viewport3DFallbackMode = "none" | "bounds-preview";
export type Viewport3DFdmQuality = "low" | "high" | "ultra";
export type Viewport3DFdmRenderMode = "glyph" | "voxel";
export type Viewport3DFdmVoxelColorMode = "orientation" | "x" | "y" | "z";
export type Viewport3DFdmSampling = 1 | 2 | 4;
export type Viewport3DFdmTopoComponent = "x" | "y" | "z";

export interface Viewport3DLayerVisibility {
  showPrimitives: boolean;
  showMesh: boolean;
  showQuantity: boolean;
}

export interface Viewport3DSceneModel {
  discretization: Viewport3DDiscretization;
  layerVisibility: Viewport3DLayerVisibility;
  selectedLayer: number;
  allLayersVisible: boolean;
  renderMode: Viewport3DRenderMode;
  opacity: number;
  worldExtent: [number, number, number] | null;
  worldCenter: [number, number, number] | null;
  topologyRevision: string | null;
  fieldRevision: string | null;
  fallbackMode: Viewport3DFallbackMode;
}

export interface Viewport3DQuantityModel {
  quantityId: string | null;
  component: Viewport3DComponent;
  everyN: number;
  colormap: string;
  autoScale: boolean;
}

export interface Viewport3DOverlayState {
  viewCubeVisible: boolean;
  legendVisible: boolean;
  statusChipsVisible: boolean;
  selectionHudVisible: boolean;
  partExplorerVisible: boolean;
}

export interface Viewport3DSelectionState {
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  selectedSidebarNodeId: string | null;
  objectViewMode: Viewport3DObjectViewMode;
}

export interface Viewport3DCameraState {
  projection: Viewport3DProjectionMode;
  navigation: Viewport3DNavigationProfile;
  lastPreset: "reset" | "front" | "top" | "right" | "iso" | null;
}

export interface Viewport3DClipState {
  enabled: boolean;
  axis: Viewport3DClipAxis;
  position: number;
  flip: 1 | -1;
}

export interface Viewport3DStatusState {
  loading: boolean;
  message: string | null;
  error: string | null;
  pendingMeshBuild: boolean;
}

export interface Viewport3DDebugState {
  rotationDebugOpen: boolean;
  liveRenderDebugOpen: boolean;
  sourceKind: "preview" | "live" | "none";
  fieldDataRevision: string | null;
  fieldDataTimestamp: number | null;
  effectiveStep: number | null;
}

export interface Viewport3DAuthoringModel {
  enabled: boolean;
  activeTool: Viewport3DInteractionMode;
  snapEnabled: boolean;
  snapSettings: {
    translateStepMeters: number;
    rotateStepDeg: number;
    scaleStep: number;
  };
}

export interface Viewport3DFdmModuleState {
  quality: Viewport3DFdmQuality;
  renderMode: Viewport3DFdmRenderMode;
  voxelColorMode: Viewport3DFdmVoxelColorMode;
  sampling: Viewport3DFdmSampling;
  brightness: number;
  voxelOpacity: number;
  voxelGap: number;
  voxelThreshold: number;
  vectorsVisible: boolean;
  topography: {
    enabled: boolean;
    component: Viewport3DFdmTopoComponent;
    amplitude: number;
  };
}

export type Viewport3DFdmModulePatch = Partial<
  Omit<Viewport3DFdmModuleState, "topography">
> & {
  topography?: Partial<Viewport3DFdmModuleState["topography"]>;
};

export interface Viewport3DModel {
  scene: Viewport3DSceneModel;
  quantity: Viewport3DQuantityModel;
  overlays: Viewport3DOverlayState;
  selection: Viewport3DSelectionState;
  camera: Viewport3DCameraState;
  clip: Viewport3DClipState;
  status: Viewport3DStatusState;
  debug: Viewport3DDebugState;
  authoring: Viewport3DAuthoringModel | null;
  fdm: Viewport3DFdmModuleState | null;
}

export interface Viewport3DToolbarState {
  rowA: {
    quantity: string | null;
    component: Viewport3DComponent;
    everyN: number;
    colormap: string;
    autoScale: boolean;
    showPrimitives: boolean;
    showMesh: boolean;
    showQuantity: boolean;
    renderMode: Viewport3DRenderMode;
    opacity: number;
    clipEnabled: boolean;
    clipAxis: Viewport3DClipAxis;
    clipPosition: number;
    clipFlip: 1 | -1;
  };
  rowB: {
    interactionMode: Viewport3DInteractionMode;
    snapEnabled: boolean;
    objectView: Viewport3DObjectViewMode;
    vectorsVisible: boolean;
    legendVisible: boolean;
    partExplorerVisible: boolean;
    projection: Viewport3DProjectionMode;
    navProfile: Viewport3DNavigationProfile;
  };
  popovers: {
    color: boolean;
    display: boolean;
    vectors: boolean;
    voxel: boolean;
    topography: boolean;
    clip: boolean;
    camera: boolean;
    panels: boolean;
    info: boolean;
    rotationDebug: boolean;
    liveRenderDebug: boolean;
    snapSettings: boolean;
  };
  controlStates: Partial<Record<string, Viewport3DControlState>>;
}

export interface Viewport3DCapability {
  enabled: boolean;
  reason?: string;
}

export interface Viewport3DCapabilities {
  preview3d: Viewport3DCapability;
  structuredGrid: Viewport3DCapability;
  explicitTopology: Viewport3DCapability;
  authoringPrimitives: Viewport3DCapability;
  vectorField: Viewport3DCapability;
  clip: Viewport3DCapability;
  screenshot: Viewport3DCapability;
  diagnostics: Viewport3DCapability;
}
