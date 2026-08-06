import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export interface FdmAirboxPassPlan {
  hasAnyEffectivePass: boolean;
  needsExtentOverlay: boolean;
  needsInactiveCellGeometry: false;
  needsVectorAnchors: boolean;
}

/**
 * The FDM Airbox is the universe extent outside magnetic support. Its
 * wireframe is an extent overlay, never a second dense cuboid-cell layer.
 * Vector anchors remain an independent sampled-data pass.
 */
export function resolveFdmAirboxPassPlan(
  settings: Pick<
    VisualizationTargetSettings,
    "boundsVisible" | "vectorsVisible" | "visible" | "wireframeVisible"
  >,
): FdmAirboxPassPlan {
  const needsExtentOverlay =
    settings.visible && (settings.boundsVisible || settings.wireframeVisible);
  const needsVectorAnchors = settings.visible && settings.vectorsVisible;

  return {
    hasAnyEffectivePass: needsExtentOverlay || needsVectorAnchors,
    needsExtentOverlay,
    needsInactiveCellGeometry: false,
    needsVectorAnchors,
  };
}
