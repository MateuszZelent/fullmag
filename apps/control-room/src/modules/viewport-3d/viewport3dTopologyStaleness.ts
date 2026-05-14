import {
  isVisualizationTopologyCurrent,
  resolveTopologyConstrainedVisualizationSettings,
  resolveVisualizationTopologyFreshness,
  type VisualizationTopologyFreshness,
} from "@/kernel/visualization/visualizationDisplayResolution";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export function resolveViewport3DTopologyFreshness(
  scene: unknown,
  manifest: unknown,
): Viewport3DTopologyFreshness {
  return resolveVisualizationTopologyFreshness(scene, manifest);
}

export function isViewport3DTopologyCurrent(
  freshness: Viewport3DTopologyFreshness,
): boolean {
  return isVisualizationTopologyCurrent(freshness);
}

export function resolveStaleTopologyVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  return resolveTopologyConstrainedVisualizationSettings(settings);
}

export type Viewport3DTopologyFreshness = VisualizationTopologyFreshness;
