import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export function opacityFromSettings(
  settings: VisualizationTargetSettings,
): number {
  return Math.max(0, Math.min(1, settings.opacityPercent / 100));
}
