import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export interface FdmAirboxPassPlan {
  hasAnyEffectivePass: boolean;
  needsExtentOverlay: boolean;
  needsInactiveCellGeometry: boolean;
  needsPointGeometry: boolean;
  needsSurfaceInstances: boolean;
  needsVectorAnchors: boolean;
}

/**
 * The FDM Airbox is the universe extent outside magnetic support. Its
 * mesh passes use the inactive cells selected from the current membership
 * artifact. Bounds remain an independent contextual extent overlay.
 */
export function resolveFdmAirboxPassPlan(
  settings: Pick<
    VisualizationTargetSettings,
    | "boundsVisible"
    | "pointsVisible"
    | "vectorsVisible"
    | "visible"
    | "wireframeVisible"
  >,
): FdmAirboxPassPlan {
  const needsExtentOverlay = settings.visible && settings.boundsVisible;
  const needsPointGeometry = settings.visible && settings.pointsVisible;
  const needsSurfaceInstances =
    settings.visible && settings.wireframeVisible;
  const needsVectorAnchors = settings.visible && settings.vectorsVisible;
  const needsInactiveCellGeometry =
    needsPointGeometry || needsSurfaceInstances || needsVectorAnchors;

  return {
    hasAnyEffectivePass: needsExtentOverlay || needsInactiveCellGeometry,
    needsExtentOverlay,
    needsInactiveCellGeometry,
    needsPointGeometry,
    needsSurfaceInstances,
    needsVectorAnchors,
  };
}
