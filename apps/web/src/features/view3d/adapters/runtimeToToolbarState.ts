import type { Viewport3DCapabilities, Viewport3DToolbarState } from "../contracts";

export interface Viewport3DToolbarInputs {
  capabilities: Viewport3DCapabilities;
  has_topology: boolean;
  has_field_data: boolean;
}

export function runtimeToViewport3DToolbarState(
  input: Viewport3DToolbarInputs,
): Viewport3DToolbarState {
  const quantity_enabled = input.has_field_data;
  const component_enabled = input.has_field_data && input.capabilities.can_show_vectors;
  const clip_enabled = input.has_topology;
  const render_mode_enabled = input.capabilities.can_render_3d;

  return {
    quantity_enabled,
    component_enabled,
    clip_enabled,
    render_mode_enabled,
    reasons: {
      quantity: quantity_enabled ? null : "field data unavailable",
      component: component_enabled ? null : "vector components unsupported",
      clip: clip_enabled ? null : "topology unavailable",
      render_mode: render_mode_enabled ? null : "3d preview unavailable",
    },
  };
}
