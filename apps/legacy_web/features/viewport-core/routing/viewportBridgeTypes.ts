/**
 * Viewport bridge types — Layer 8
 *
 * Typed interfaces for the selection, overlay, and diagnostics bridges
 * that mediate between the view-registry hosted view and the rest of
 * the workspace (tree selection, HUD overlays, diagnostic flags).
 *
 * These types are consumed by the eventual per-view presenter components
 * (ViewportScenePresenterFDM, ViewportScenePresenterFEM, etc.) that will
 * replace the inline rendering blocks in the legacy ViewportPanels.
 */

// ── Selection Bridge ─────────────────────────────────────────

/** Data flowing from the model tree / sidebar into the viewport. */
export interface ViewportSelectionBridgeState {
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  selectedSidebarNodeId: string | null;
  objectViewMode: "context" | "isolate";
}

/** Callbacks the viewport raises back to the workspace shell. */
export interface ViewportSelectionBridgeActions {
  onObjectSelect: (objectId: string | null) => void;
  onEntitySelect: (entityId: string | null) => void;
  onEntityFocus: (entityId: string | null) => void;
  onSidebarNodeSelect: (nodeId: string | null) => void;
  onObjectViewModeChange: (mode: "context" | "isolate") => void;
}

// ── Overlay Bridge ───────────────────────────────────────────

/** Minimal description of a HUD overlay shown on top of the viewport. */
export interface ViewportOverlayDescriptor {
  id: string;
  kind: "telemetry-hud" | "object-label" | "gizmo" | "selection-rect";
  visible: boolean;
}

export interface ViewportOverlayBridgeState {
  overlays: readonly ViewportOverlayDescriptor[];
  /** Whether the telemetry HUD is visible. */
  telemetryHudVisible: boolean;
}

// ── Diagnostics Bridge ───────────────────────────────────────

/** Feature‐flag snapshot relevant to viewport rendering. */
export interface Viewport3DStageFlags {
  viewport3d_unified_model: boolean;
  viewport3d_unified_toolbar: boolean;
  viewport3d_unified_render_core: boolean;
  viewport3d_unified_fdm_modules: boolean;
  viewport3d_unified_authoring: boolean;
  viewport3d_unified_routing: boolean;
  viewport3d_unified_cutover: boolean;
}

/** Feature‐flag snapshot relevant to viewport rendering. */
export interface ViewportDiagnosticFlags {
  useMinimalViewportSelectionPath: boolean;
  enableGlobalScalarCard: boolean;
  enableGridScalar2D: boolean;
  enableUnifiedViewport3D: boolean;
  enableUnifiedViewportToolbar: boolean;
  enableSlice2D: boolean;
  femViewportShowToolbar: boolean;
  femViewportForceWireframe: boolean;
  femViewportForceDisableClip: boolean;
  viewport3dStages?: Viewport3DStageFlags;
}

// ── Composite host props ─────────────────────────────────────

/**
 * Props required by a view host component mounted by ViewportRouter.
 * Each concrete presenter (FDM, FEM, Analyze, …) will accept these
 * plus its own domain-specific props.
 */
export interface ViewHostProps {
  selection: ViewportSelectionBridgeState;
  selectionActions: ViewportSelectionBridgeActions;
  overlays: ViewportOverlayBridgeState;
  diagnosticFlags: ViewportDiagnosticFlags;
}
