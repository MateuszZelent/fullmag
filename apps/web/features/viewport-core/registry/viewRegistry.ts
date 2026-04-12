/**
 * View Registry — Layer 8
 *
 * Declarative registry mapping view kinds to metadata.
 * ViewportRouter uses this to resolve which view component should be active
 * based on workspace context (view mode, selected node, solver state).
 *
 * The actual React components are **not** imported here to keep the registry
 * side-effect free and serialisable.  Components are resolved lazily by
 * ViewportRouter via dynamic `import()` or a thin lookup table in the
 * router module itself.
 */

// ── View kind ────────────────────────────────────────────────

/** Canonical set of view kinds the viewport area can host. */
export type ViewKind =
  | "viewport-3d"
  | "viewport-2d"
  | "mesh-workspace"
  | "analyze"
  | "table"
  | "chart"
  | "report"
  | "empty";

// ── Context passed to canOpen / the view host ────────────────

export interface WorkspaceViewContext {
  /** Current high-level viewport mode from toolbar. */
  viewportMode: "3D" | "2D" | "Mesh" | "Analyze";
  /** Whether solver session data (vectors, fields) is available. */
  hasSessionData: boolean;
  /** Whether FEM mesh data is loaded. */
  hasFemMesh: boolean;
  /** Whether the user has selected a results node in the tree. */
  selectedResultNodeId: string | null;
  /** Discretization of the active session if known. */
  discretization: "fdm" | "fem" | null;
}

// ── Registry entry ───────────────────────────────────────────

export interface ViewRegistryEntry {
  /** Unique stable ID — one per entry. */
  id: string;
  /** Enum kind for fast pattern matching in the router. */
  kind: ViewKind;
  /** Human-readable title shown in tab/window headers. */
  title: string;
  /**
   * The key used in the lazy component lookup table.
   * Not a React component reference, keeping this file free of JSX imports.
   */
  componentKey: string;
  /** Guard: can this view be opened given current workspace context? */
  canOpen: (ctx: WorkspaceViewContext) => boolean;
}

// ── Built-in entries ─────────────────────────────────────────

const VIEWPORT_3D_FDM: ViewRegistryEntry = {
  id: "viewport-3d-fdm",
  kind: "viewport-3d",
  title: "3-D FDM Viewport",
  componentKey: "MagnetizationView3D",
  canOpen: (ctx) => ctx.viewportMode === "3D" && ctx.discretization !== "fem",
};

const VIEWPORT_3D_FEM: ViewRegistryEntry = {
  id: "viewport-3d-fem",
  kind: "viewport-3d",
  title: "3-D FEM Viewport",
  componentKey: "FemMeshView3D",
  canOpen: (ctx) => ctx.viewportMode === "3D" && ctx.discretization === "fem",
};

const VIEWPORT_2D: ViewRegistryEntry = {
  id: "viewport-2d",
  kind: "viewport-2d",
  title: "2-D Slice",
  componentKey: "MagnetizationSlice2D",
  canOpen: (ctx) => ctx.viewportMode === "2D",
};

const MESH_WORKSPACE: ViewRegistryEntry = {
  id: "mesh-workspace",
  kind: "mesh-workspace",
  title: "Mesh Workspace",
  componentKey: "FemMeshView3D_Mesh",
  canOpen: (ctx) => ctx.viewportMode === "Mesh",
};

const ANALYZE_WORKSPACE: ViewRegistryEntry = {
  id: "analyze-workspace",
  kind: "analyze",
  title: "Analyze",
  componentKey: "AnalyzeViewport",
  canOpen: (ctx) => ctx.viewportMode === "Analyze",
};

const EMPTY_VIEW: ViewRegistryEntry = {
  id: "empty",
  kind: "empty",
  title: "No Data",
  componentKey: "EmptyState",
  canOpen: () => true,
};

// ── Registry array (ordered by priority, first match wins) ───

export const VIEW_REGISTRY: readonly ViewRegistryEntry[] = [
  VIEWPORT_3D_FEM,
  VIEWPORT_3D_FDM,
  VIEWPORT_2D,
  MESH_WORKSPACE,
  ANALYZE_WORKSPACE,
  EMPTY_VIEW,
];

// ── Resolver ─────────────────────────────────────────────────

/**
 * Given current workspace context, return the first registry entry
 * whose `canOpen` guard returns `true`.  Falls back to `EMPTY_VIEW`.
 */
export function resolveActiveView(ctx: WorkspaceViewContext): ViewRegistryEntry {
  for (const entry of VIEW_REGISTRY) {
    if (entry.canOpen(ctx)) return entry;
  }
  return EMPTY_VIEW;
}

/** Look up a registry entry by its stable `id`. */
export function findViewById(id: string): ViewRegistryEntry | undefined {
  return VIEW_REGISTRY.find((e) => e.id === id);
}
