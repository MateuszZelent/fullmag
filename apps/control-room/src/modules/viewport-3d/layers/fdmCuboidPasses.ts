import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export interface FdmCuboidPassPlan {
  hasAnyEffectivePass: boolean;
  needsCellModel: boolean;
  needsPointGeometry: boolean;
  needsSurfaceInstances: boolean;
  needsVectors: boolean;
}

export function resolveFdmCuboidPassPlan(
  settings: Pick<
    VisualizationTargetSettings,
    | "boundsVisible"
    | "pointsVisible"
    | "shaderVisible"
    | "vectorsVisible"
    | "wireframeVisible"
  >,
): FdmCuboidPassPlan {
  const needsSurfaceInstances =
    settings.shaderVisible || settings.wireframeVisible;
  const needsPointGeometry = settings.pointsVisible;
  const needsVectors = settings.vectorsVisible;
  const needsCellModel =
    needsSurfaceInstances || needsPointGeometry || needsVectors;
  return {
    hasAnyEffectivePass: needsCellModel || settings.boundsVisible,
    needsCellModel,
    needsPointGeometry,
    needsSurfaceInstances,
    needsVectors,
  };
}
