import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

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

/**
 * Before the runtime publishes the target-only Airbox carrier (for example a
 * prepared session awaiting Compute), the Airbox extent is the authored
 * Universe box. It is used only while no carrier view exists, so a published
 * carrier always wins and the two extents are never mixed.
 */
export function resolveFdmMultilayerAuthoredAirboxBoundsOverlay(
  carrierView: Pick<FdmMultilayerAirboxRenderView, "domain"> | null,
  authoredUniverseBounds: Viewport3DBounds | null,
  settings: Pick<VisualizationTargetSettings, "boundsVisible" | "visible" | "wireframeVisible">,
): FdmMultilayerAirboxBoundsOverlayModel | null {
  if (carrierView || !authoredUniverseBounds || !settings.visible) return null;
  if (!settings.boundsVisible && !settings.wireframeVisible) return null;
  return {
    bounds: authoredUniverseBounds,
    boundsVisible: settings.boundsVisible,
    fullWireframeVisible: settings.wireframeVisible,
    targetId: "airbox",
  };
}
