import {
  isVisualizationTopologyCurrent,
  isVisualizationTopologyRenderable,
  resolveTopologyConstrainedVisualizationSettings,
  resolveVisualizationTopologyFreshness,
  type VisualizationTopologyFreshness,
} from "@/kernel/visualization/visualizationDisplayResolution";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export function resolveViewport3DTopologyFreshness(
  scene: unknown,
  manifest: unknown,
  context: {
    domainMeta?: unknown;
    topology?: unknown;
  } = {},
): Viewport3DTopologyFreshness {
  if (hasLoadedFemDomainTopology(context.domainMeta, context.topology)) {
    const resolved = resolveVisualizationTopologyFreshness(scene, manifest);
    return resolved === "unknown" ? "current" : resolved;
  }

  return resolveVisualizationTopologyFreshness(scene, manifest);
}

export function isViewport3DTopologyCurrent(
  freshness: Viewport3DTopologyFreshness,
): boolean {
  return isVisualizationTopologyCurrent(freshness);
}

export function isViewport3DTopologyRenderable(
  freshness: Viewport3DTopologyFreshness,
): boolean {
  return isVisualizationTopologyRenderable(freshness);
}

export function resolveUnavailableTopologyVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  return resolveTopologyConstrainedVisualizationSettings(settings);
}

export function resolveViewport3DTopologyFreshnessLabel(
  freshness: Viewport3DTopologyFreshness,
): string | null {
  if (freshness === "current") return null;
  if (freshness === "stale") return "topology stale";
  return "topology freshness unknown";
}

export function resolveUnknownTopologyProvenanceRefreshKey(
  scene: unknown,
  manifest: unknown,
): string | null {
  const sceneRevision = asFiniteNumber(asRecord(scene)?.revision);
  const manifestRecord = asRecord(manifest);
  const manifestRevision = asFiniteNumber(manifestRecord?.revision);
  const sourceSceneRevision = asFiniteNumber(
    manifestRecord?.source_scene_revision,
  );
  if (
    sceneRevision === null ||
    manifestRevision === null ||
    sourceSceneRevision !== null
  ) {
    return null;
  }

  return `${sceneRevision}:${manifestRevision}`;
}

export type Viewport3DTopologyFreshness = VisualizationTopologyFreshness;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasLoadedFemDomainTopology(domainMeta: unknown, topology: unknown): boolean {
  const metaRecord = asRecord(domainMeta);
  const topologyRecord = asRecord(topology);
  const nodeCount = asFiniteNumber(topologyRecord?.nodeCount);
  return (
    metaRecord?.discretization === "fem" &&
    nodeCount !== null &&
    nodeCount > 0
  );
}
