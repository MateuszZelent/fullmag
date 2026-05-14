import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export type Viewport3DTopologyFreshness = "current" | "stale" | "unknown";

type JsonRecord = Record<string, unknown>;

export function resolveViewport3DTopologyFreshness(
  scene: unknown,
  manifest: unknown,
): Viewport3DTopologyFreshness {
  const sceneRevision = asFiniteNumber(asRecord(scene)?.revision);
  const sourceSceneRevision = asFiniteNumber(
    asRecord(manifest)?.source_scene_revision,
  );

  if (sceneRevision === null || sourceSceneRevision === null) {
    return "unknown";
  }

  return sceneRevision === sourceSceneRevision ? "current" : "stale";
}

export function isViewport3DTopologyCurrent(
  freshness: Viewport3DTopologyFreshness,
): boolean {
  return freshness === "current";
}

export function resolveStaleTopologyVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const staleVisible = settings.visible;
  const wireframeVisible =
    staleVisible &&
    (settings.shaderVisible ||
      settings.wireframeVisible ||
      settings.pointsVisible ||
      settings.vectorsVisible);

  return {
    ...settings,
    geometryScope: "surface",
    opacityPercent: Math.min(settings.opacityPercent, 35),
    pointsVisible: false,
    renderMode: "wireframe",
    shaderVisible: false,
    vectorAlphaPercent: 0,
    vectorsVisible: false,
    wireframeOpacityPercent: Math.max(settings.wireframeOpacityPercent, 45),
    wireframeVisible,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
