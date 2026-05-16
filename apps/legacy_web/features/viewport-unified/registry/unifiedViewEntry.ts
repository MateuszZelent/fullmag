/**
 * Unified 3-D viewport registry entry.
 *
 * Replaces the separate VIEWPORT_3D_FDM / VIEWPORT_3D_FEM entries
 * with a single entry that activates for Mesh authoring before solver data
 * exists and for 3-D results once session data is available.
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
    ctx.viewportMode === "Mesh" ||
    ctx.viewportMode === "3D",
};
