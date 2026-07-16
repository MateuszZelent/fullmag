import type {
  Viewport3DBuildJobKey,
  Viewport3DBuildJobKeyParts,
  Viewport3DBuildLane,
} from "./viewport3dBuildEngineTypes";

interface NormalizedBuildJobKey {
  readonly algorithmVersion: number;
  readonly component?: string | null;
  readonly domainId: string;
  readonly domainGenerationId?: string | null;
  readonly fieldRevision?: string | null;
  readonly lane: Viewport3DBuildLane;
  readonly quantityId?: string | null;
  readonly samplingRevision?: string;
  readonly scopeId?: string | null;
  readonly scopeKind?: string | null;
  readonly sessionId: string;
  readonly styleRevision?: string;
  readonly targetVisualizationRevision?: string;
  readonly topologyRevision: string | null;
}

export function buildViewport3DTopologyIndexJobKey(
  parts: Viewport3DBuildJobKeyParts,
): Viewport3DBuildJobKey {
  return buildViewport3DBuildJobKey({
    algorithmVersion: parts.algorithmVersion,
    domainId: parts.domainId,
    lane: "topology-index",
    sessionId: parts.sessionId,
    topologyRevision: parts.topologyRevision,
  });
}

export function buildViewport3DFieldColorJobKey(
  parts: Viewport3DBuildJobKeyParts,
): Viewport3DBuildJobKey {
  return buildViewport3DBuildJobKey({
    algorithmVersion: parts.algorithmVersion,
    component: parts.component,
    domainId: parts.domainId,
    domainGenerationId: parts.domainGenerationId,
    fieldRevision: parts.fieldRevision,
    lane: "field-color",
    quantityId: parts.quantityId,
    samplingRevision: parts.samplingRevision,
    scopeId: parts.scopeId,
    scopeKind: parts.scopeKind,
    sessionId: parts.sessionId,
    styleRevision: parts.styleRevision,
    targetVisualizationRevision: parts.targetVisualizationRevision,
    topologyRevision: parts.topologyRevision,
  });
}

export function buildViewport3DFdmCuboidJobKey(
  parts: Viewport3DBuildJobKeyParts,
): Viewport3DBuildJobKey {
  return buildViewport3DBuildJobKey({
    algorithmVersion: parts.algorithmVersion,
    component: parts.component,
    domainId: parts.domainId,
    domainGenerationId: parts.domainGenerationId,
    fieldRevision: parts.fieldRevision,
    lane: "fdm-cuboid",
    quantityId: parts.quantityId,
    samplingRevision: parts.samplingRevision,
    scopeId: parts.scopeId,
    scopeKind: parts.scopeKind,
    sessionId: parts.sessionId,
    styleRevision: parts.styleRevision,
    targetVisualizationRevision: parts.targetVisualizationRevision,
    topologyRevision: parts.topologyRevision,
  });
}

export function buildViewport3DVectorGlyphJobKey(
  parts: Viewport3DBuildJobKeyParts,
): Viewport3DBuildJobKey {
  return buildViewport3DBuildJobKey({
    algorithmVersion: parts.algorithmVersion,
    component: parts.component,
    domainId: parts.domainId,
    domainGenerationId: parts.domainGenerationId,
    fieldRevision: parts.fieldRevision,
    lane: "vector-glyph",
    quantityId: parts.quantityId,
    samplingRevision: parts.samplingRevision,
    scopeId: parts.scopeId,
    scopeKind: parts.scopeKind,
    sessionId: parts.sessionId,
    styleRevision: parts.styleRevision,
    targetVisualizationRevision: parts.targetVisualizationRevision,
    topologyRevision: parts.topologyRevision,
  });
}

export function buildViewport3DRegionOverlayJobKey(
  parts: Viewport3DBuildJobKeyParts,
): Viewport3DBuildJobKey {
  return buildViewport3DBuildJobKey({
    algorithmVersion: parts.algorithmVersion,
    domainId: parts.domainId,
    lane: "region-overlay",
    sessionId: parts.sessionId,
    styleRevision: parts.styleRevision,
    targetVisualizationRevision: parts.targetVisualizationRevision,
    topologyRevision: parts.topologyRevision,
  });
}

function buildViewport3DBuildJobKey(
  normalized: NormalizedBuildJobKey,
): Viewport3DBuildJobKey {
  return `${normalized.lane}:${JSON.stringify(normalized)}`;
}
