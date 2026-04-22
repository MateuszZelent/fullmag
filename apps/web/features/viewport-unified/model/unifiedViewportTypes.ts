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

/**
 * Top-level FEM layer visibility toggles (P3).
 * Mirrors the three semantic rendering layers present in FEM viewports:
 * geometric bodies (primitives), mesh wireframe, and the field quantity overlay.
 */
export interface FemViewportLayerState {
  /** Show geometric primitive bodies (solids). */
  showPrimitives: boolean;
  /** Show mesh wireframe overlay. */
  showMesh: boolean;
  /** Show field quantity colour overlay. */
  showQuantity: boolean;
}

export const DEFAULT_FEM_VIEWPORT_LAYER_STATE: FemViewportLayerState = {
  showPrimitives: true,
  showMesh: false,
  showQuantity: true,
};

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

  /**
   * P3 — FEM layer visibility toggles. Present only when `explicit_topology`
   * capability is active. Undefined for FDM.
   */
  femLayers?: FemViewportLayerState;
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
