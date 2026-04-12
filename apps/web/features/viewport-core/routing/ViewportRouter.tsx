/**
 * ViewportRouter — Layer 8
 *
 * Thin routing component that resolves which view should be active
 * using the view registry and renders it.
 *
 * Currently this coexists with the legacy `ViewportCanvasArea` in
 * `ViewportPanels.tsx`.  As responsibilities are incrementally migrated
 * to view-registry entries, this router will replace the monolithic
 * conditional block in `ViewportPanels`.
 *
 * State classification:
 *   - `viewportMode`           → transient (toolbar selection)
 *   - `discretization`         → runtime telemetry
 *   - `hasSessionData`         → runtime telemetry
 *   - `selectedResultNodeId`   → workspace (tree selection)
 */

"use client";

import { memo, useMemo, type ReactNode } from "react";
import {
  resolveActiveView,
  type WorkspaceViewContext,
  type ViewRegistryEntry,
} from "../registry/viewRegistry";

// ── Props ────────────────────────────────────────────────────

export interface ViewportRouterProps {
  /** Workspace context used by the registry guard functions. */
  context: WorkspaceViewContext;
  /**
   * Render callback that receives the resolved registry entry.
   * The consumer is responsible for mapping `entry.componentKey` → JSX.
   * This keeps the router free of concrete component imports.
   */
  renderView: (entry: ViewRegistryEntry) => ReactNode;
}

// ── Component ────────────────────────────────────────────────

/**
 * Resolves the active view via the view registry and delegates rendering
 * to the caller-provided `renderView` callback.
 *
 * Usage:
 * ```tsx
 * <ViewportRouter
 *   context={viewCtx}
 *   renderView={(entry) => {
 *     switch (entry.componentKey) {
 *       case "VectorFieldView3D": return <VectorFieldView3D {...props} />;
 *       case "FemMeshView3D":       return <FemMeshView3D {...props} />;
 *       // …
 *     }
 *   }}
 * />
 * ```
 */
export const ViewportRouter = memo(function ViewportRouter({
  context,
  renderView,
}: ViewportRouterProps) {
  const activeEntry = useMemo(() => resolveActiveView(context), [context]);
  return <>{renderView(activeEntry)}</>;
});

/**
 * Hook form of the same resolution logic, for callers that want the entry
 * without a dedicated component boundary.
 */
export function useResolvedView(ctx: WorkspaceViewContext): ViewRegistryEntry {
  return useMemo(() => resolveActiveView(ctx), [ctx]);
}
