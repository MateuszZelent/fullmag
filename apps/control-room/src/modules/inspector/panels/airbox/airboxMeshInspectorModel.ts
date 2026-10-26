import type {
  JsonObject,
  MeshActiveBuildResource,
  MeshLastSuccessfulBuildResource,
  MeshSharedDomainManifestResource,
  MeshSummaryResource,
  MeshUniverseConfigResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
} from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import {
  isVisualizationAirboxId,
  isVisualizationAirboxRole,
} from "@/kernel/selection/selectionTypes";
import { boundedDisplayText, boundedItems } from "./airboxDisplay";

type AirboxMeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

export interface AirboxMeshPartsAggregate {
  boundaryFaceCount: number | null;
  carrierCount: number;
  elementCount: number | null;
  nodeCount: number | null;
  nodeCountExact: boolean;
  partIds: readonly string[];
  surfaceFaceCount: number | null;
}

type JsonRecord = Record<string, unknown>;

export interface AirboxMeshBuildModel {
  buildMode: string | null;
  effectiveAirboxTarget: JsonRecord | null;
  fallbacks: readonly string[];
  fallbacksPublished: boolean;
  operationStatuses: NonNullable<
    NonNullable<MeshActiveBuildResource["shared_domain_build_report"]>["operation_statuses"]
  >;
  phases: NonNullable<MeshActiveBuildResource["mesh_pipeline_status"]>;
  policyDiff: NonNullable<MeshActiveBuildResource["policy_diff"]>;
  provenance: {
    buildId: string | null;
    commandId: string | null;
    completedAtUnixMs: number | null;
    durationMs: number | null;
    geometryRealizationRevision: number | null;
    meshRevision: number | null;
    requestedPolicyRevision: number | null;
    sourceSceneRevision: number | null;
  };
  publishedResources: NonNullable<MeshActiveBuildResource["published_resources"]> | null;
  rawDetails: {
    serialized: string;
    sourceByteLength: number;
    truncated: boolean;
  };
  reason: string;
  resolvedPolicy: JsonRecord | null;
  revision: number | null;
  sceneRevision: number | null;
  sourceSceneRevision: number | null;
  freshness: "current" | "stale" | "unknown";
  status: "current" | "degraded" | "missing";
  latestSuccess: {
    artifactPublished: boolean;
    effectiveAirboxTarget: JsonRecord | null;
    geometryRealizationRevision: number | null;
    lastBuildError: string | null;
    lastSuccess: unknown;
    resourceRevision: number | null;
    sourceSceneRevision: number | null;
  };
}

export function buildAirboxMeshBuildModel({
  current,
  currentSceneRevision = null,
  latest = null,
  report,
}: {
  current: MeshActiveBuildResource | null;
  currentSceneRevision?: number | null;
  latest?: MeshLastSuccessfulBuildResource | null;
  report: MeshUniverseReportResource | null;
}): AirboxMeshBuildModel {
  const reportRecord = asJsonRecord(report?.report);
  const reportStatus = stringField(reportRecord, "status");
  const buildReport = current?.shared_domain_build_report ?? null;
  const fallbacksPublished = Array.isArray(buildReport?.fallbacks_triggered);
  const phases = boundedItems(current?.mesh_pipeline_status ?? []);
  const operationStatuses = boundedItems(buildReport?.operation_statuses ?? []);
  const fallbacks = boundedItems(buildReport?.fallbacks_triggered ?? []);
  const failedPhase = phases.find((phase) =>
    isDegradedBuildStatus(phase.status),
  );
  const failedOperation = operationStatuses.find((operation) =>
    isDegradedBuildStatus(operation.status),
  );
  const directReason =
    current?.last_build_error ??
    failedPhase?.detail ??
    failedOperation?.reason ??
    (fallbacks.length > 0
      ? `Fallbacks triggered: ${fallbacks.join(", ")}.`
      : null) ??
    stringField(reportRecord, "reason") ??
    stringField(reportRecord, "error");
  const degraded = Boolean(
    current?.last_build_error ||
    failedPhase ||
    failedOperation ||
    buildReport?.degraded ||
    isDegradedBuildStatus(reportStatus) ||
    stringField(reportRecord, "error"),
  );
  const missing = !current && !report;
  const latestSuccessArtifact = asJsonRecord(latest?.last_success);
  const latestSuccessArtifactPublished = latestSuccessArtifact !== null;
  const latestSuccessGeometryRealization = asJsonRecord(
    latestSuccessArtifact?.geometry_realization,
  );
  const sourceSceneRevision =
    current?.source_scene_revision ??
    current?.provenance?.source_scene_revision ??
    null;
  const sceneRevision = finiteRevision(currentSceneRevision);
  const reportTarget = asJsonRecord(reportRecord?.effective_airbox_target);
  const summaryTarget = asJsonRecord(current?.last_build_summary?.effective_airbox_target);
  const freshness =
    sourceSceneRevision === null || sceneRevision === null
      ? "unknown"
      : sourceSceneRevision === sceneRevision
        ? "current"
        : "stale";
  return {
    buildMode: boundedDisplayText(buildReport?.build_mode),
    effectiveAirboxTarget: asJsonRecord(
      buildReport?.effective_airbox_target ??
        current?.effective_airbox_target ??
        summaryTarget ??
        reportTarget,
    ),
    fallbacks: fallbacks.map((fallback) => boundedDisplayText(fallback) ?? ""),
    fallbacksPublished,
    operationStatuses: operationStatuses.map((operation) => ({
      ...operation,
      kind: boundedDisplayText(operation.kind) ?? "",
      reason: boundedDisplayText(operation.reason),
      scope: boundedDisplayText(operation.scope) ?? "",
      status: boundedDisplayText(operation.status) ?? "",
    })),
    phases: phases.map((phase) => ({
      ...phase,
      detail: boundedDisplayText(phase.detail),
      id: boundedDisplayText(phase.id),
      label: boundedDisplayText(phase.label),
      progress_label: boundedDisplayText(phase.progress_label),
      status: boundedDisplayText(phase.status),
    })),
    policyDiff: current?.policy_diff ?? [],
    provenance: {
      buildId: boundedDisplayText(current?.provenance?.build_id),
      commandId: boundedDisplayText(current?.provenance?.command_id),
      completedAtUnixMs: current?.provenance?.completed_at_unix_ms ?? null,
      durationMs: current?.provenance?.duration_ms ?? null,
      geometryRealizationRevision:
        current?.provenance?.geometry_realization_revision ?? null,
      meshRevision: current?.provenance?.mesh_revision ?? null,
      requestedPolicyRevision:
        current?.provenance?.requested_policy_revision ?? null,
      sourceSceneRevision:
        current?.provenance?.source_scene_revision ?? sourceSceneRevision,
    },
    publishedResources: current?.published_resources
      ? {
          ...current.published_resources,
          manifest: boundedDisplayText(current.published_resources.manifest) ?? "",
          quality: boundedDisplayText(current.published_resources.quality) ?? "",
          realized_size_fields:
            boundedDisplayText(current.published_resources.realized_size_fields) ?? "",
        }
      : null,
    rawDetails: boundedRawAggregate({
      activeBuild: current?.active_build ?? null,
      currentEffectiveAirboxTarget: current?.effective_airbox_target ?? null,
      lastBuildSummary: current?.last_build_summary ?? null,
      latestEffectiveAirboxTarget: latest?.effective_airbox_target ?? null,
      latestSuccess: latest?.last_success ?? null,
      policyDiff: current?.policy_diff ?? null,
      resolvedPolicy: current?.resolved_policy ?? null,
      universeReport: report ?? null,
    }),
    reason: boundedDisplayText(missing
      ? "No Airbox mesh build evidence is available."
      : degraded
        ? directReason ?? "Backend reported degraded mesh build evidence."
        : reportStatus
          ? `Backend build status is ${reportStatus}.`
          : "Mesh build evidence is available.") ?? "not available",
    resolvedPolicy: asJsonRecord(current?.resolved_policy),
    revision: current?.revision ?? report?.revision ?? null,
    sceneRevision,
    sourceSceneRevision,
    freshness,
    status: missing ? "missing" : degraded ? "degraded" : "current",
    latestSuccess: {
      artifactPublished: latestSuccessArtifactPublished,
      effectiveAirboxTarget: asJsonRecord(latest?.effective_airbox_target),
      geometryRealizationRevision:
        latestSuccessArtifactPublished
          ? numericField(latestSuccessArtifact, "realization_revision") ??
            numericField(latestSuccessGeometryRealization, "realization_revision")
          : null,
      lastBuildError: boundedDisplayText(latest?.last_build_error),
      lastSuccess: null,
      resourceRevision: latest?.revision ?? null,
      sourceSceneRevision: latestSuccessArtifactPublished
        ? numericField(latestSuccessArtifact, "source_scene_revision") ??
          numericField(latestSuccessGeometryRealization, "source_scene_revision")
        : null,
    },
  };
}

const DEGRADED_BUILD_STATUSES = new Set([
  "aborted",
  "canceled",
  "cancelled",
  "degraded",
  "error",
  "failed",
  "failure",
  "fallback",
  "invalid",
  "rejected",
  "unavailable",
  "warning",
]);

export function isDegradedBuildStatus(
  status: string | null | undefined,
): boolean {
  const normalized = status?.trim().toLowerCase() ?? "";
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens[0] === "not" || tokens.includes("recovered") || normalized === "error_free") {
    return false;
  }
  if (DEGRADED_BUILD_STATUSES.has(normalized)) return true;
  return tokens.some((token) => DEGRADED_BUILD_STATUSES.has(token));
}

function boundedRawAggregate(value: Record<string, unknown>): AirboxMeshBuildModel["rawDetails"] {
  const encoder = new TextEncoder();
  const serialized = JSON.stringify(value);
  const sourceByteLength = encoder.encode(serialized).byteLength;
  if (sourceByteLength <= 4_096) {
    return { serialized, sourceByteLength, truncated: false };
  }
  const fields = Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      {
        byteLength: encoder.encode(JSON.stringify(field)).byteLength,
        truncated: true,
      },
    ]),
  );
  const bounded = JSON.stringify({ fields, sourceByteLength, truncated: true });
  return {
    serialized: bounded,
    sourceByteLength,
    truncated: true,
  };
}

export interface AirboxMeshInspectorModel {
  airboxPart: AirboxMeshPart | null;
  airboxParts: readonly AirboxMeshPart[];
  build: {
    reason: string;
    revision: number | null;
    status: "complete" | "degraded" | "missing";
  };
  lifecycle: {
    reason: string;
    status: "current" | "missing" | "stale";
  };
  parameters: {
    authored: JsonObject | null;
    effective: JsonObject | null;
    resolvedTarget: JsonRecord | null;
  };
  qualityGates: {
    evidence: "backend" | "ui-derived";
    marker: number | null;
    reason: string;
    scope: string | null;
    source: string | null;
    status: "pass" | "fail" | "unknown";
    checks: readonly {
      comparison: string | null;
      id: string;
      status: "pass" | "fail" | "unknown";
      threshold: number | null;
      unit: string | null;
      value: number | null;
    }[];
  };
  statistics: {
    boundaryFaceCount: number | null;
    elementCount: number | null;
    nodeCount: number | null;
    pyramid5Count: number | null;
    surfaceFaceCount: number | null;
    tet4Count: number | null;
    volumeElementCountScope: "airbox-parts" | "shared-domain" | "unpublished";
    volumeElementsByType: readonly { count: number; family: string }[];
    qualityByFamily: readonly AirboxMeshFamilyQuality[];
    qualityScope: { label: string | null; marker: number | null };
  };
  topology: {
    bounds: { max: readonly number[]; min: readonly number[] } | null;
    sharedInterfaceNodes: {
      count: number | null;
      label: "Shared interface nodes";
      ownership: "shared";
    };
  };
}

export interface AirboxMeshFamilyQualityMetric {
  belowThresholdCount: number | null;
  belowThresholdFraction: number | null;
  max: number | null;
  mean: number | null;
  min: number | null;
  p05: number | null;
  reason: string | null;
  source: string | null;
  status: "available" | "unavailable" | "unknown";
  threshold: number | null;
}

export interface AirboxMeshFamilyQuality {
  cellCount: number | null;
  family: string;
  gamma: AirboxMeshFamilyQualityMetric | null;
  mixedTopologyScaledJacobian: AirboxMeshFamilyQualityMetric & {
    metric: string | null;
    certificateFingerprint: string | null;
  } | null;
  sicn: AirboxMeshFamilyQualityMetric | null;
  source: string | null;
}

export function airboxSizeDistributionPresentation(distribution: {
  id: "edge_length" | "tetra_size" | "volume";
  label: string;
}): { label: string; unit: "m" | "m³" } {
  return {
    label: distribution.id === "tetra_size"
      ? "Equivalent tetrahedral size"
      : distribution.label,
    unit: distribution.id === "volume" ? "m³" : "m",
  };
}

function currentAirboxMeshEvidence<T extends { revision: number }>(
  resource: Pick<
    ResourceResult<T>,
    "data" | "error" | "refreshError" | "status"
  >,
  topologyIdentityMatches: boolean,
  currentMeshRevision: number | null | undefined,
): T | null {
  if (
    !topologyIdentityMatches ||
    resource.status !== "ready" ||
    resource.error ||
    resource.refreshError ||
    !resource.data ||
    !matchesCurrentAirboxMeshRevision(
      resource.data.revision,
      currentMeshRevision,
    )
  ) {
    return null;
  }
  return resource.data;
}

export function matchesCurrentAirboxMeshRevision(
  resourceRevision: number | null | undefined,
  currentMeshRevision: number | null | undefined,
): boolean {
  return (
    typeof currentMeshRevision === "number" &&
    Number.isSafeInteger(currentMeshRevision) &&
    currentMeshRevision > 0 &&
    resourceRevision === currentMeshRevision
  );
}

export function currentAirboxQualityEvidence(
  resource: Pick<
    ResourceResult<MeshUniverseQualityResource>,
    "data" | "error" | "refreshError" | "status"
  >,
  topologyIdentityMatches: boolean,
  currentMeshRevision: number | null | undefined,
): MeshUniverseQualityResource | null {
  return currentAirboxMeshEvidence(
    resource,
    topologyIdentityMatches,
    currentMeshRevision,
  );
}

export function currentAirboxReportEvidence(
  resource: Pick<
    ResourceResult<MeshUniverseReportResource>,
    "data" | "error" | "refreshError" | "status"
  >,
  topologyIdentityMatches: boolean,
  currentMeshRevision: number | null | undefined,
): MeshUniverseReportResource | null {
  return currentAirboxMeshEvidence(
    resource,
    topologyIdentityMatches,
    currentMeshRevision,
  );
}

export function findCanonicalAirboxPart(
  parts: readonly AirboxMeshPart[] | null | undefined,
): AirboxMeshPart | null {
  if (!parts?.length) return null;
  return (
    parts.find((part) => isVisualizationAirboxRole(part.role)) ??
    parts.find((part) => isVisualizationAirboxId(part.id)) ??
    null
  );
}

export function findAirboxParts(
  parts: readonly AirboxMeshPart[] | null | undefined,
): AirboxMeshPart[] {
  return (
    parts?.filter(
      (part) =>
        isVisualizationAirboxRole(part.role) || isVisualizationAirboxId(part.id),
    ) ?? []
  );
}

export function aggregateAirboxMeshParts(
  parts: readonly AirboxMeshPart[] | null | undefined,
): AirboxMeshPartsAggregate {
  const airboxParts = findAirboxParts(parts);
  const nodeCoverage = resolveAirboxNodeCoverage(airboxParts);
  return {
    boundaryFaceCount: sumPartCount(airboxParts, "boundary_face_count"),
    carrierCount: airboxParts.length,
    elementCount: sumPartCount(airboxParts, "element_count"),
    nodeCount: nodeCoverage.count,
    nodeCountExact: nodeCoverage.exact,
    partIds: airboxParts.map((part) => part.id),
    surfaceFaceCount: sumSurfaceFaceCount(airboxParts),
  };
}

export function aggregateAirboxBounds(
  parts: readonly AirboxMeshPart[] | null | undefined,
): { max: readonly number[]; min: readonly number[] } | null {
  if (!parts?.length) return null;
  const bounds = parts.map((part) => {
    const min = finiteBounds(part.bounds_min);
    const max = finiteBounds(part.bounds_max);
    return min && max ? { max, min } : null;
  });
  if (bounds.some((value) => value === null)) return null;

  const first = bounds[0];
  if (!first) return null;
  const min = [...first.min];
  const max = [...first.max];
  for (const value of bounds.slice(1)) {
    if (!value) return null;
    for (let index = 0; index < 3; index += 1) {
      min[index] = Math.min(min[index], value.min[index]);
      max[index] = Math.max(max[index], value.max[index]);
    }
  }
  return { max, min };
}

function finiteBounds(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const first = value[0];
  const second = value[1];
  const third = value[2];
  if (
    typeof first !== "number" || !Number.isFinite(first) ||
    typeof second !== "number" || !Number.isFinite(second) ||
    typeof third !== "number" || !Number.isFinite(third)
  ) {
    return null;
  }
  return [first, second, third];
}

function sumPartCount(
  parts: readonly AirboxMeshPart[],
  key: "boundary_face_count" | "element_count",
): number | null {
  if (!parts.length) return null;
  let total = 0;
  for (const part of parts) {
    const count = safeMeshCount(part[key]);
    if (count === null || total > Number.MAX_SAFE_INTEGER - count) return null;
    total += count;
  }
  return total;
}

function sumSurfaceFaceCount(parts: readonly AirboxMeshPart[]): number | null {
  if (!parts.length || parts.some((part) => !Array.isArray(part.surface_faces))) {
    return null;
  }
  let total = 0;
  for (const part of parts) {
    const count = part.surface_faces?.length ?? 0;
    if (total > Number.MAX_SAFE_INTEGER - count) return null;
    total += count;
  }
  return total;
}

function resolveAirboxNodeCoverage(parts: readonly AirboxMeshPart[]): {
  count: number | null;
  exact: boolean;
} {
  if (!parts.length) return { count: null, exact: false };
  const intervals: Array<readonly [number, number]> = [];
  for (const part of parts) {
    const explicit = part.node_indices ?? [];
    const declaredCount = safeMeshCount(part.node_count);
    if (explicit.length > 0 && declaredCount === explicit.length) {
      const indices = explicit.map((index) => safeMeshCount(index));
      if (indices.some((index): index is null => index === null)) {
        return { count: null, exact: false };
      }
      const sorted = [...(indices as number[])].sort((a, b) => a - b);
      let start = sorted[0];
      let previous = sorted[0];
      for (const index of sorted.slice(1)) {
        if (index > previous + 1) {
          intervals.push([start, previous + 1]);
          start = index;
        }
        previous = index;
      }
      intervals.push([start, previous + 1]);
      continue;
    }

    const start = safeMeshCount(part.node_start);
    const count = safeMeshCount(part.node_count);
    if (
      start === null ||
      count === null ||
      start > Number.MAX_SAFE_INTEGER - count
    ) {
      return { count: null, exact: false };
    }
    if (count > 0) intervals.push([start, start + count]);
  }

  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;
  for (const [start, end] of intervals) {
    if (currentStart === null || currentEnd === null) {
      currentStart = start;
      currentEnd = end;
      continue;
    }
    if (start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  if (currentStart !== null && currentEnd !== null) {
    total += currentEnd - currentStart;
  }
  return Number.isSafeInteger(total)
    ? { count: total, exact: true }
    : { count: null, exact: false };
}

function aggregateElementCountsByType(
  parts: readonly AirboxMeshPart[],
): JsonRecord | null {
  if (!parts.length) return null;
  const aggregate: JsonRecord = {};
  for (const part of parts) {
    const counts = asJsonRecord(asJsonRecord(part)?.element_counts_by_type);
    if (!counts) return null;
    for (const [family, rawCount] of Object.entries(counts)) {
      const count = safeMeshCount(rawCount);
      if (count === null) return null;
      const previous = aggregate[family];
      const previousCount = previous === undefined ? 0 : safeMeshCount(previous);
      if (previousCount === null || previousCount > Number.MAX_SAFE_INTEGER - count) {
        return null;
      }
      aggregate[family] = previousCount + count;
    }
  }
  return Object.keys(aggregate).length ? aggregate : null;
}

function safeMeshCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function buildAirboxMeshInspectorModel({
  currentSceneRevision = null,
  manifest,
  policy,
  quality,
  report,
  summary,
}: {
  currentSceneRevision?: number | null;
  manifest: MeshSharedDomainManifestResource | null;
  policy: MeshUniverseConfigResource;
  quality: MeshUniverseQualityResource | null;
  report: MeshUniverseReportResource | null;
  summary: MeshSummaryResource | null;
}): AirboxMeshInspectorModel {
  const airboxPart = findCanonicalAirboxPart(manifest?.mesh_parts);
  const airboxParts = findAirboxParts(manifest?.mesh_parts);
  const meshPartAggregate = aggregateAirboxMeshParts(airboxParts);
  const airboxBounds = aggregateAirboxBounds(airboxParts);
  const reportRecord = asJsonRecord(report?.report);
  const qualityRecord = asJsonRecord(quality?.quality);
  const reportTarget = asJsonRecord(reportRecord?.effective_airbox_target);
  const resolvedTarget =
    asJsonRecord(summary?.effective_airbox_target) ?? reportTarget;
  const sceneRevision = finiteRevision(currentSceneRevision);
  const sourceSceneRevision = finiteRevision(manifest?.source_scene_revision);
  const sceneEvidenceStale =
    sceneRevision !== null &&
    sourceSceneRevision !== null &&
    sourceSceneRevision !== sceneRevision;
  const sceneEvidenceCurrent =
    sceneRevision !== null &&
    sourceSceneRevision !== null &&
    sourceSceneRevision === sceneRevision;
  const reportStatus = stringField(reportRecord, "status");
  const reportReason = stringField(reportRecord, "reason");
  const reportError = stringField(reportRecord, "error");
  const reportDegraded =
    isDegradedBuildStatus(reportStatus) || reportError !== null;
  const globalQuality = asJsonRecord(qualityRecord?.global);
  const airboxElementCountsByType = aggregateElementCountsByType(airboxParts);
  const sharedDomainElementCountsByType = asJsonRecord(
    asJsonRecord(manifest)?.element_counts_by_type,
  );
  const elementCountsByType =
    aggregateElementCountsByType(airboxParts) ?? sharedDomainElementCountsByType;
  const volumeElementCountScope = airboxElementCountsByType
    ? "airbox-parts"
    : sharedDomainElementCountsByType
      ? "shared-domain"
      : "unpublished";
  const volumeElementsByType = Object.entries(elementCountsByType ?? {})
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
    )
    .map(([family, count]) => ({ count, family }));

  return {
    airboxPart,
    airboxParts,
    build: !report
      ? { reason: "Universe mesh report is not available.", revision: null, status: "missing" }
      : reportDegraded
        ? {
            reason:
              reportReason ??
              reportError ??
              `Backend build status is ${reportStatus}.`,
            revision: report.revision,
            status: "degraded",
          }
        : {
            reason: reportStatus
              ? `Backend build status is ${reportStatus}.`
              : "Universe mesh report is available.",
            revision: report.revision,
            status: "complete",
          },
    lifecycle: sceneEvidenceStale
      ? {
          reason: `Mesh source scene revision ${sourceSceneRevision} does not match current scene revision ${sceneRevision}.`,
          status: "stale",
        }
      : !manifest || !sceneEvidenceCurrent
        ? {
            reason: manifest
              ? "Source scene provenance is unavailable; mesh freshness cannot be verified."
              : "No realized mesh evidence is available.",
            status: "missing",
          }
        : { reason: "Mesh source scene provenance matches the current scene.", status: "current" },
    parameters: {
      authored: policy.config ?? null,
      effective: policy.effective_config ?? null,
      resolvedTarget,
    },
    qualityGates: buildAirboxQualityGateModel(qualityRecord, {
      freshness: sceneEvidenceStale
        ? "stale"
        : sceneEvidenceCurrent
          ? "current"
          : "unknown",
    }),
    statistics: {
      boundaryFaceCount: meshPartAggregate.boundaryFaceCount,
      elementCount: meshPartAggregate.elementCount,
      nodeCount: meshPartAggregate.nodeCount,
      pyramid5Count: numericField(elementCountsByType, "pyramid5"),
      surfaceFaceCount: meshPartAggregate.surfaceFaceCount,
      tet4Count: numericField(elementCountsByType, "tet4"),
      volumeElementCountScope,
      volumeElementsByType,
      qualityByFamily: normalizeAirboxFamilyQuality(globalQuality?.quality_by_family),
      qualityScope: {
        label: stringField(globalQuality, "label"),
        marker: numericField(globalQuality, "marker"),
      },
    },
    topology: {
      bounds:
        airboxBounds ?? (airboxPart?.bounds_min && airboxPart.bounds_max
          ? { max: airboxPart.bounds_max, min: airboxPart.bounds_min }
          : null),
      sharedInterfaceNodes: {
        count: numericField(reportRecord, "shared_interface_node_count"),
        label: "Shared interface nodes",
        ownership: "shared",
      },
    },
  };
}

function buildAirboxQualityGateModel(
  quality: JsonRecord | null,
  options: { freshness?: "current" | "stale" | "unknown" } = {},
) {
  const scoped = asJsonRecord(quality?.airbox_quality_gates);
  if (!scoped) {
    return {
      evidence: "backend" as const,
      reason: "Airbox-scoped quality gates are not published by the backend.",
      scope: null,
      marker: null,
      source: null,
      status: "unknown" as const,
      checks: [],
    };
  }
  const status = stringField(scoped, "status");
  const scope = stringField(scoped, "scope");
  const marker = numericField(scoped, "marker");
  const source = stringField(scoped, "source");
  const checks = normalizeQualityGateChecks(scoped.checks);
  if (options.freshness !== "current") {
    return {
      evidence: "backend" as const,
      reason: options.freshness === "stale"
        ? "Airbox quality gates are stale for the current source scene."
        : "Airbox quality gate source scene provenance is not verified.",
      scope,
      marker,
      source,
      status: "unknown" as const,
      checks,
    };
  }
  if (scope !== "airbox" || marker !== 0 || !source) {
    return {
      evidence: "backend" as const,
      reason: "Backend quality evidence does not identify Airbox marker 0 and its source.",
      scope,
      marker,
      source,
      status: "unknown" as const,
      checks,
    };
  }
  return {
    evidence: "backend" as const,
    reason:
      stringField(scoped, "reason") ??
      (status ? `Backend Airbox gate status is ${status}.` : "Backend did not provide a gate reason."),
    scope,
    marker,
    source,
    status: status === "pass" ? ("pass" as const) : status === "fail" ? ("fail" as const) : ("unknown" as const),
    checks,
  };
}

function normalizeAirboxFamilyQuality(value: unknown): AirboxMeshFamilyQuality[] {
  const families = asJsonRecord(value);
  if (!families) return [];
  return Object.entries(families).flatMap(([family, raw]) => {
    const record = asJsonRecord(raw);
    if (!record) return [];
    const mixedMetric = normalizeMixedTopologyScaledJacobian(
      record.mixed_topology_scaled_jacobian,
    );
    const mixedRecord = asJsonRecord(record.mixed_topology_scaled_jacobian);
    const mixed = mixedMetric
      ? {
          ...mixedMetric,
          metric: stringField(mixedRecord, "metric"),
          certificateFingerprint:
            stringField(mixedRecord, "certificate_fingerprint") ??
            stringField(mixedRecord, "topology_fingerprint"),
        }
      : null;
    return [{
      cellCount: safeMeshCount(record.cell_count),
      family,
      gamma: normalizeFamilyMetric(record.gamma),
      mixedTopologyScaledJacobian: mixed,
      sicn: normalizeFamilyMetric(record.sicn),
      source: stringField(record, "source"),
    }];
  });
}

function normalizeMixedTopologyScaledJacobian(
  value: unknown,
): AirboxMeshFamilyQualityMetric | null {
  const record = asJsonRecord(value);
  if (!record) return null;
  if (stringField(record, "status") === "unavailable") {
    return normalizeFamilyMetric(record);
  }
  if (
    numericField(record, "min") === null &&
    numericField(record, "p05") === null
  ) {
    return normalizeFamilyMetric(record);
  }
  return {
    belowThresholdCount: null,
    belowThresholdFraction: null,
    max: null,
    mean: null,
    min: numericField(record, "min"),
    p05: numericField(record, "p05"),
    reason: null,
    source: stringField(record, "source"),
    status: "available",
    threshold: null,
  };
}

function normalizeFamilyMetric(value: unknown): AirboxMeshFamilyQualityMetric | null {
  const record = asJsonRecord(value);
  if (!record) return null;
  const status = stringField(record, "status");
  return {
    belowThresholdCount: safeMeshCount(record.below_threshold_count),
    belowThresholdFraction: numericField(record, "below_threshold_fraction"),
    max: numericField(record, "max"),
    mean: numericField(record, "mean"),
    min: numericField(record, "min"),
    p05: numericField(record, "p05"),
    reason: stringField(record, "reason"),
    source: stringField(record, "source"),
    status: status === "available" ? "available" : status === "unavailable" ? "unavailable" : "unknown",
    threshold: numericField(record, "threshold"),
  };
}

function normalizeQualityGateChecks(value: unknown): AirboxMeshInspectorModel["qualityGates"]["checks"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const record = asJsonRecord(raw);
    const id = stringField(record, "id");
    if (!record || !id) return [];
    const status = stringField(record, "status");
    return [{
      comparison: stringField(record, "comparison"),
      id,
      status: status === "pass" ? "pass" as const : status === "fail" ? "fail" as const : "unknown" as const,
      threshold: numericField(record, "threshold"),
      unit: stringField(record, "unit"),
      value: numericField(record, "value"),
    }];
  });
}

function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringField(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numericField(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteRevision(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
