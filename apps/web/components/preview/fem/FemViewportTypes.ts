import type {
  ArrowSamplingMode,
  FemArrowColorMode,
  FemColorField,
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
  RenderMode,
  ClipAxis,
} from "../FemMeshView3D";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";

export type FemViewportProjection = "perspective" | "orthographic";
export type FemViewportNavigation = "trackball" | "cad";
export type FemViewportVisualPreset =
  | "shaded"
  | "shadedEdges"
  | "hiddenLine"
  | "quality"
  | "partTint"
  | "field";

export interface FemViewportClipState {
  enabled: boolean;
  axis: ClipAxis;
  position: number;
  flip: boolean;
}

export type FemViewportOverlayPopover =
  | "quantity"
  | "color"
  | "clip"
  | "display"
  | "vectors"
  | "camera"
  | "panels"
  | null;

export interface FemViewportViewState {
  renderMode: RenderMode;
  opacity: number;
  arrowColorMode: FemArrowColorMode;
  arrowMonoColor: string;
  arrowAlpha: number;
  arrowLengthScale: number;
  arrowThickness: number;
  arrowSamplingMode: ArrowSamplingMode;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  previewMaxPoints: number;
  shrinkFactor: number;
  projection: FemViewportProjection;
  navigation: FemViewportNavigation;
  clip: FemViewportClipState;
  arrowsVisible: boolean;
  qualityProfile: ViewportQualityProfileId;
  legendOpen: boolean;
  labeledMode: boolean;
  openPopover: FemViewportOverlayPopover;
}

export interface FemViewportPanelsState {
  partExplorerOpen: boolean;
}

export interface FemViewportRuntimeState {
  interactionActive: boolean;
  textureGizmoDragging: boolean;
  sampledArrowCount?: number;
  captureActive: boolean;
  captureOverlayHidden: boolean;
}

export interface FemViewportToolbarState {
  surfaceColorField: FemColorField;
  arrowColorField: FemArrowColorMode;
}

export interface FemViewportSelectionState {
  selectedFaceIndices: number[];
  hoveredFaceIndex: number | null;
}

export interface FemViewportStoreState {
  view: FemViewportViewState;
  panels: FemViewportPanelsState;
  runtime: FemViewportRuntimeState;
  toolbar: FemViewportToolbarState;
  selection: FemViewportSelectionState;
}
