/**
 * Unified viewport types for FDM and FEM rendering.
 *
 * Common render state works for both discretizations; FEM-specific
 * controls (wireframe, clip, mesh opacity) are optional and
 * capability-gated at the UI layer.
 */

import type {
  SpatialDomainAdapter,
  DomainInfo,
  RenderGeometry,
} from "../../../src/domain/adapters/SpatialDomainAdapter";

export interface UnifiedRenderState {
  // Common
  selectedLayer: number;
  allLayersVisible: boolean;
  vectorComponent: "3D" | "x" | "y" | "z" | "|v|";
  colorScale: string;
  autoScale: boolean;
  maxPoints: number;
  everyN: number;

  // Capability-gated (FEM-specific become optional)
  meshRenderMode?: "solid" | "wireframe" | "points";
  meshOpacity?: number;
  clipEnabled?: boolean;
  clipAxis?: "x" | "y" | "z";
  clipPosition?: number;
  arrowColorMode?: string;
  arrowMonoColor?: string;
  arrowLengthScale?: number;
  arrowThickness?: number;
  vectorDomainFilter?: string;
  ferromagnetVisibilityMode?: string;
}

export const DEFAULT_UNIFIED_RENDER_STATE: UnifiedRenderState = {
  selectedLayer: 0,
  allLayersVisible: false,
  vectorComponent: "3D",
  colorScale: "viridis",
  autoScale: true,
  maxPoints: 50000,
  everyN: 1,
};

export interface UnifiedViewportModel {
  adapter: SpatialDomainAdapter;
  renderState: UnifiedRenderState;
  domainInfo: DomainInfo;
  geometry: RenderGeometry;
}
