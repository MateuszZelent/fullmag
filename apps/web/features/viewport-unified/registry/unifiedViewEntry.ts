/**
 * Unified 3-D viewport registry entry.
 *
 * Replaces the separate VIEWPORT_3D_FDM / VIEWPORT_3D_FEM entries
 * with a single entry that activates for any discretization when the
 * workspace is in 3-D mode with session data.
 */

import type {
  ViewKind,
  ViewRegistryEntry,
  WorkspaceViewContext,
} from "../../viewport-core/registry/viewRegistry";

export const UNIFIED_VIEWPORT_3D: ViewRegistryEntry = {
  id: "viewport-3d-unified",
  kind: "viewport-3d" as ViewKind,
  title: "3D Viewport",
  componentKey: "UnifiedViewport3D",
  canOpen: (ctx: WorkspaceViewContext) =>
    ((ctx.viewportMode === "3D") ||
      (ctx.viewportMode === "Mesh" && ctx.discretization === "fdm")) &&
    ctx.hasSessionData,
};
