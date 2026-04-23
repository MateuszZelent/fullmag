export interface Viewport3DRouteFlagsInput {
  enableUnifiedViewport3D: boolean;
  enableUnifiedViewportToolbar: boolean;
}

export interface Viewport3DStageFlags {
  viewport3d_unified_model: boolean;
  viewport3d_unified_toolbar: boolean;
  viewport3d_unified_render_core: boolean;
  viewport3d_unified_fdm_modules: boolean;
  viewport3d_unified_authoring: boolean;
  viewport3d_unified_routing: boolean;
  viewport3d_unified_cutover: boolean;
}

/**
 * Map stage-oriented rollout semantics onto current runtime route flags.
 *
 * This keeps v3 stage naming available without multiplying long-lived
 * runtime toggles while migration is still in progress.
 */
export function mapRouteFlagsToViewport3DStages(
  input: Viewport3DRouteFlagsInput,
): Viewport3DStageFlags {
  const toolbar = input.enableUnifiedViewportToolbar;
  const routing = input.enableUnifiedViewport3D;
  // Stage 8 cutover landed in runtime routing: legacy FDM 3D path is no longer mounted.
  const cutover = routing;
  return {
    viewport3d_unified_model: routing,
    viewport3d_unified_toolbar: toolbar,
    viewport3d_unified_render_core: routing,
    viewport3d_unified_fdm_modules: cutover,
    viewport3d_unified_authoring: toolbar,
    viewport3d_unified_routing: routing,
    viewport3d_unified_cutover: cutover,
  };
}
