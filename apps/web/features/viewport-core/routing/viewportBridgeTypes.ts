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
  telemetryHudVisible: boolean;
}

// ── Diagnostics Bridge ───────────────────────────────────────

/** Feature‐flag snapshot relevant to viewport rendering. */
export interface ViewportDiagnosticFlags {
  useMinimalViewportSelectionPath: boolean;
  enableGlobalScalarCard: boolean;
  enableGridScalar2D: boolean;
  enableFemMeshWorkspace: boolean;
  enableFem3D: boolean;
  enableFdm3D: boolean;
  enableSlice2D: boolean;
  femViewportShowToolbar: boolean;
  femViewportForceWireframe: boolean;
  femViewportForceDisableClip: boolean;
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
