import type { VisualizationTargetSettings } from "./ObjectVisualizationController";

export type VisualizationTopologyFreshness = "current" | "stale" | "unknown";

export type ManifestRenderableCarrierKind =
  | "mesh-parts"
  | "mixed"
  | "object-segments"
  | "unavailable";

interface VisualizationRenderDegradation {
  code: "topology-provenance-unknown" | "topology-stale";
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
  const sceneRecord = asRecord(scene);
  const sceneRevision = asFiniteNumber(sceneRecord?.revision);
  const manifestRecord = asRecord(manifest);
  const sourceSceneRevision = asFiniteNumber(manifestRecord?.source_scene_revision);

  if (sceneRevision === null) {
    return "unknown";
  }

  if (sourceSceneRevision === null) {
    const cleanTopologyCoverage =
      !sceneHasDirtyGeometry(sceneRecord) &&
      manifestCoversVisibleSceneObjects(sceneRecord, manifestRecord);
    if (sceneHasDirtyGeometry(sceneRecord)) {
      return "unknown";
    }
    if (!manifestRecord) {
      return sceneHasKnownObjects(sceneRecord) ? "current" : "unknown";
    }
    return cleanTopologyCoverage ? "current" : "unknown";
  }

  return sceneRevision === sourceSceneRevision ? "current" : "stale";
}

export function isVisualizationTopologyCurrent(
  freshness: VisualizationTopologyFreshness,
): boolean {
  return freshness === "current";
}

export function isVisualizationTopologyRenderable(
  freshness: VisualizationTopologyFreshness,
): boolean {
  return freshness !== "unknown";
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
  if (!topologyFreshness || topologyFreshness === "current") {
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
            ? "topology-stale"
            : "topology-provenance-unknown",
        message:
          topologyFreshness === "stale"
            ? "Mesh topology is stale; rendering an edge-only ghost view."
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

function sceneHasDirtyGeometry(scene: JsonRecord | null): boolean {
  if (!Array.isArray(scene?.objects)) {
    return false;
  }

  return scene.objects.some((objValue) => {
    const obj = asRecord(objValue);
    if (!obj) return false;
    const tags = Array.isArray(obj.tags) ? obj.tags.map(String) : [];
    return tags.includes("mesh:dirty") || tags.includes("mesh:building");
  });
}

function sceneHasKnownObjects(scene: JsonRecord | null): boolean {
  return Array.isArray(scene?.objects) && scene.objects.length > 0;
}

function manifestCoversVisibleSceneObjects(
  scene: JsonRecord | null,
  manifest: JsonRecord | null,
): boolean {
  if (!Array.isArray(scene?.objects)) {
    return false;
  }

  const visibleSceneObjectIds = scene.objects.flatMap((item) => {
    const object = asRecord(item);
    const objectId = object?.id;
    return object &&
      object.visible !== false &&
      typeof objectId === "string" &&
      objectId.length > 0
      ? [objectId]
      : [];
  });

  if (visibleSceneObjectIds.length === 0) {
    return false;
  }

  const manifestObjectIds = new Set<string>();
  const meshParts = Array.isArray(manifest?.mesh_parts)
    ? manifest.mesh_parts
    : [];
  const objectSegments = Array.isArray(manifest?.object_segments)
    ? manifest.object_segments
    : [];
  if (
    resolveManifestRenderableCarrierKind({
      meshPartCount: meshParts.length,
      objectSegmentCount: objectSegments.length,
    }) === "unavailable"
  ) {
    return false;
  }

  for (const collection of [objectSegments, meshParts]) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      const objectId = asRecord(value)?.object_id;
      if (typeof objectId === "string" && objectId.length > 0) {
        manifestObjectIds.add(objectId);
      }
    }
  }

  return visibleSceneObjectIds.every((objectId) => manifestObjectIds.has(objectId));
}

export function resolveManifestRenderableCarrierKind({
  meshPartCount,
  objectSegmentCount,
}: {
  meshPartCount: number;
  objectSegmentCount: number;
}): ManifestRenderableCarrierKind {
  if (meshPartCount > 0 && objectSegmentCount > 0) return "mixed";
  if (meshPartCount > 0) return "mesh-parts";
  if (objectSegmentCount > 0) return "object-segments";
  return "unavailable";
}
