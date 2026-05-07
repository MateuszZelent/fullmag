import type { FieldSliceMeta, FieldSliceQuery } from "../../api/types";
import type {
  DomainRevisionState,
  QuantitySelectionState,
  SlicePlaneState,
  SharedSurfaceStatus,
} from "../workspaceSync/contracts";

export type SliceRenderMode =
  | "heatmap"
  | "contour"
  | "heatmap+contour"
  | "vectors"
  | "mesh-overlay";

export type SliceAirboxRenderMode =
  | "surface"
  | "wireframe"
  | "surface+edges"
  | "points";

export type SliceProjectionReduction =
  | "mean_occupied"
  | "sum"
  | "thickness_integral"
  | "area_weighted_mean"
  | "min"
  | "max"
  | "rms"
  | "stddev"
  | "abs_max";

export type Slice2DInteractionMode =
  | "pan_zoom"
  | "select"
  | "probe"
  | "measure"
  | "profile";

export interface Slice2DToolbarState {
  quantityId: string;
  component: "x" | "y" | "z" | "magnitude";
  axis: "x" | "y" | "z";
  mode: "single" | "slab" | "all_layers";
  layerIndex: number | null;
  positionPercent: number;
  positionWorld: number | null;
  normalAxisBounds: { min: number; max: number } | null;
  magneticExtent: { min: number; max: number } | null;
  thicknessPercent: number | null;
  colormap: string;
  autoContrast: boolean;
  showPrimitives: boolean;
  showMesh: boolean;
  showMagneticTexture: boolean;
  showAirbox: boolean;
  airboxRenderMode: SliceAirboxRenderMode;
  showAirboxVectors: boolean;
  showQuantity: boolean;
  showVectors: boolean;
  renderMode: SliceRenderMode;
  projectionReduction: SliceProjectionReduction;
  projectionIncludeAirAsZero: boolean;
  projectionSamples: number;
  projectionResolution: number;
}

export interface Slice2DCapabilities {
  preview_2d: boolean;
  structured_grid: boolean;
  explicit_topology: boolean;
  authoring_primitives: boolean;
  slice_probe: boolean;
  slice_measure: boolean;
  slice_profile: boolean;
  slice_vectors: boolean;
  slice_all_layers: boolean;
}

export type Slice2DCapabilityGateMap = {
  [K in keyof Slice2DCapabilities]: {
    enabled: boolean;
    reason: string | null;
  };
};

export interface Slice2DDiagnostics {
  status: SharedSurfaceStatus;
  messages: string[];
  staleProfile: boolean;
  staleProbe: boolean;
}

export interface SliceRenderState {
  query: FieldSliceQuery | null;
  meta: FieldSliceMeta | null;
  sampling: "fdm-layer" | "fem-plane" | "unavailable";
}

export interface SliceOverlayState {
  showPrimitives: boolean;
  showMesh: boolean;
  showMagneticTexture: boolean;
  showAirbox: boolean;
  showQuantity: boolean;
  showVectors: boolean;
}

export interface SliceInteractionState {
  mode: Slice2DInteractionMode;
  probePoint: [number, number] | null;
  profileLine: [[number, number], [number, number]] | null;
}

export interface Slice2DModel {
  quantity: QuantitySelectionState;
  plane: SlicePlaneState;
  toolbar: Slice2DToolbarState;
  overlays: SliceOverlayState;
  interaction: SliceInteractionState;
  render: SliceRenderState;
  revisions: DomainRevisionState;
  capabilities: Slice2DCapabilities;
  capabilityGates: Slice2DCapabilityGateMap;
  diagnostics: Slice2DDiagnostics;
}

export interface SliceBuildRequest {
  quantity: QuantitySelectionState;
  plane: SlicePlaneState;
  toolbar: Slice2DToolbarState;
  revisions: DomainRevisionState;
}

export interface SliceFrame {
  query: FieldSliceQuery | null;
  sampling: SliceRenderState["sampling"];
  diagnostics: string[];
}

export interface Slice2DAdapter {
  kind: "fdm" | "fem";
  buildSlice(request: SliceBuildRequest): SliceFrame;
}
