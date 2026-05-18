import type { VisualizationTargetSettings } from "./ObjectVisualizationController";

export type VisualizationTopologyFreshness = "current" | "stale" | "unknown";

interface VisualizationRenderDegradation {
  code: "topology-provenance-stale" | "topology-provenance-unknown";
  message: string;
}

export interface VisualizationRenderResolution {
  degradedReasons: VisualizationRenderDegradation[];
  finalSettings: VisualizationTargetSettings;
  requestedSettings: VisualizationTargetSettings;
}

type JsonRecord = Record<string, unknown>;

export function resolveVisualizationTopologyFreshness(
  scene: unknown,
  manifest: unknown,
): VisualizationTopologyFreshness {
  const sceneRevision = asFiniteNumber(asRecord(scene)?.revision);
  const sourceSceneRevision = asFiniteNumber(
    asRecord(manifest)?.source_scene_revision,
  );

  if (sceneRevision === null || sourceSceneRevision === null) {
    return "unknown";
  }

  return sceneRevision === sourceSceneRevision ? "current" : "stale";
}

export function isVisualizationTopologyCurrent(
  freshness: VisualizationTopologyFreshness,
): boolean {
  return freshness === "current";
}

export function resolveTopologyConstrainedVisualizationSettings(
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

export function resolveVisualizationRenderResolution({
  effectiveSettings,
  settings,
  topologyFreshness,
}: {
  effectiveSettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
  topologyFreshness?: VisualizationTopologyFreshness | null;
}): VisualizationRenderResolution {
  if (!topologyFreshness || isVisualizationTopologyCurrent(topologyFreshness)) {
    return {
      degradedReasons: [],
      finalSettings: effectiveSettings,
      requestedSettings: settings,
    };
  }

  return {
    degradedReasons: [
      {
        code:
          topologyFreshness === "stale"
            ? "topology-provenance-stale"
            : "topology-provenance-unknown",
        message:
          topologyFreshness === "stale"
            ? "Mesh topology is stale; rendering an edge-only safety view."
            : "Mesh provenance is unknown; rendering an edge-only safety view.",
      },
    ],
    finalSettings: resolveTopologyConstrainedVisualizationSettings(
      effectiveSettings,
    ),
    requestedSettings: settings,
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
