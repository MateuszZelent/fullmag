import type { LiveStatus } from "../../../api/types";
import type { Viewport3DCapabilities } from "../contracts";

const EMPTY: Viewport3DCapabilities = {
  can_render_3d: false,
  can_show_topology: false,
  can_show_structured_grid: false,
  can_show_vectors: false,
  can_show_scalar_history: false,
  algorithms_available: [],
};

/**
 * Canonical mapper from `status.capabilities` into Viewport3D capability model.
 * This adapter intentionally does not use `status.domain.discretization`.
 */
export function statusToViewport3DCapabilities(
  status: Pick<LiveStatus, "capabilities"> | null | undefined,
): Viewport3DCapabilities {
  const capabilities = status?.capabilities;
  if (!capabilities) {
    return EMPTY;
  }

  return {
    can_render_3d: Boolean(capabilities.preview_3d),
    can_show_topology: Boolean(capabilities.explicit_topology),
    can_show_structured_grid: Boolean(capabilities.structured_grid),
    can_show_vectors: Boolean(
      capabilities.binary_fields && (capabilities.node_fields || capabilities.cell_fields),
    ),
    can_show_scalar_history: Boolean(capabilities.scalar_history),
    algorithms_available: Array.isArray(capabilities.algorithms_available)
      ? capabilities.algorithms_available
      : [],
  };
}
