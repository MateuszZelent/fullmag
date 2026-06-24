"use client";

import { buildViewport3DRegionOverlayJobKey } from "../build-engine/viewport3dBuildJobKeys";

export interface Viewport3DRegionOverlayBuildReferenceInput {
  readonly domainId: string;
  readonly regionSignature: string;
  readonly sessionId: string;
  readonly targetVisualizationRevision: string | number | null;
  readonly topologyRevision: string | number | null;
}

export interface Viewport3DRegionOverlayBuildReference {
  readonly buildKey: string;
  readonly groupKey: string;
  readonly revisionSummary: string;
}

export interface Viewport3DRegionOverlayIdentity {
  readonly magneticParts: unknown;
  readonly regions: unknown;
  readonly renderedSurfacePartIds: unknown;
  readonly selectedObjectId: string | null;
  readonly selectedRegionId: string | null;
  readonly settingsByRegionId: unknown;
  readonly theme: string;
  readonly topology: unknown;
}

export interface Viewport3DRegionOverlayBuildStatusInput {
  readonly enabled: boolean;
  readonly hasCompatibleModels: boolean;
  readonly hasCompatibleTopologyModels: boolean;
  readonly hasCompatibleUnavailableState: boolean;
  readonly hasTopology: boolean;
  readonly pendingForCurrentRequest: boolean;
}

export type Viewport3DRegionOverlayBuildStatus =
  | "disabled"
  | "pending"
  | "ready"
  | "stale-visible"
  | "unavailable";

export function createViewport3DRegionOverlayBuildReference({
  domainId,
  regionSignature,
  sessionId,
  targetVisualizationRevision,
  topologyRevision,
}: Viewport3DRegionOverlayBuildReferenceInput): Viewport3DRegionOverlayBuildReference | null {
  if (!topologyRevision) return null;

  const resolvedTargetRevision =
    targetVisualizationRevision == null
      ? "unknown"
      : String(targetVisualizationRevision);
  const resolvedTopologyRevision = String(topologyRevision);
  const styleRevision = `regions=${regionSignature}`;

  return {
    buildKey: buildViewport3DRegionOverlayJobKey({
      algorithmVersion: 1,
      component: null,
      domainId,
      fieldRevision: null,
      quantityId: null,
      samplingRevision: "region-overlay",
      scopeId: null,
      scopeKind: null,
      sessionId,
      styleRevision,
      targetVisualizationRevision: resolvedTargetRevision,
      topologyRevision: resolvedTopologyRevision,
    }),
    groupKey: `region-overlay:session=${sessionId}:domain=${domainId}`,
    revisionSummary: [
      `topology=${resolvedTopologyRevision}`,
      `targets=${resolvedTargetRevision}`,
      styleRevision,
    ].join(" "),
  };
}

export function viewport3DRegionOverlayIdentityIsCompatible(
  previous: Viewport3DRegionOverlayIdentity,
  next: Viewport3DRegionOverlayIdentity,
): boolean {
  return (
    previous.topology === next.topology &&
    previous.magneticParts === next.magneticParts &&
    previous.regions === next.regions &&
    previous.renderedSurfacePartIds === next.renderedSurfacePartIds &&
    previous.selectedObjectId === next.selectedObjectId &&
    previous.selectedRegionId === next.selectedRegionId &&
    previous.settingsByRegionId === next.settingsByRegionId &&
    previous.theme === next.theme
  );
}

export function resolveViewport3DRegionOverlayBuildStatus({
  enabled,
  hasCompatibleModels,
  hasCompatibleTopologyModels,
  hasCompatibleUnavailableState,
  hasTopology,
  pendingForCurrentRequest,
}: Viewport3DRegionOverlayBuildStatusInput): Viewport3DRegionOverlayBuildStatus {
  if (!enabled) return "disabled";
  if (!hasTopology) return "unavailable";
  if (pendingForCurrentRequest) {
    return hasCompatibleModels || hasCompatibleTopologyModels
      ? "stale-visible"
      : "pending";
  }
  if (hasCompatibleModels) return "ready";
  if (hasCompatibleUnavailableState) return "unavailable";
  return "pending";
}
