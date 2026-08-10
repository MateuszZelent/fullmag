import type {
  FdmMultilayerAirboxRenderView,
} from "../viewport3dDomainAdapter";
import type { Viewport3DBounds } from "../viewport3dRenderModel";

export interface FdmMultilayerAirboxBoundsOverlayModel {
  /** The target-only carrier bounds; never the common transform grid. */
  bounds: Viewport3DBounds;
  /** The target identity used for picking and telemetry. */
  targetId: string;
  /** Render the outer extent when the target's bounds channel is enabled. */
  boundsVisible: boolean;
  /** Render the complete target volume grid with hidden-edge semantics. */
  fullWireframeVisible: boolean;
}

/**
 * Resolve the target-only Airbox extent overlay from the published carrier
 * view.  No legacy universe-support or common-transform input is accepted,
 * so the overlay cannot accidentally render a different grid.
 */
export function resolveFdmMultilayerAirboxBoundsOverlay(
  view: Pick<FdmMultilayerAirboxRenderView, "domain" | "settings" | "target"> | null,
): FdmMultilayerAirboxBoundsOverlayModel | null {
  if (
    !view ||
    view.target.id !== "airbox" ||
    view.domain.kind !== "fdm-multilayer-airbox" ||
    !view.domain.bounds ||
    !view.settings.visible
  ) {
    return null;
  }
  if (!view.settings.boundsVisible && !view.settings.wireframeVisible) return null;
  return {
    bounds: view.domain.bounds,
    boundsVisible: view.settings.boundsVisible,
    fullWireframeVisible: view.settings.wireframeVisible,
    targetId: view.target.id,
  };
}
