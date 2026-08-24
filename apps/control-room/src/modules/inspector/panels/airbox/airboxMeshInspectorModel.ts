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
    effectiveAirboxTarget: JsonRecord | null;
    geometryRealizationRevision: number | null;
    lastBuildError: string | null;
    lastSuccess: unknown;
    revision: number | null;
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
  const sourceSceneRevision =
    current?.source_scene_revision ??
    current?.provenance?.source_scene_revision ??
    null;
  const sceneRevision = finiteRevision(currentSceneRevision);
  const freshness =
    sourceSceneRevision === null || sceneRevision === null
      ? "unknown"
      : sourceSceneRevision === sceneRevision
        ? "current"
        : "stale";
  return {
    buildMode: boundedDisplayText(buildReport?.build_mode),
    effectiveAirboxTarget: asJsonRecord(
      buildReport?.effective_airbox_target ?? current?.effective_airbox_target,
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
      effectiveAirboxTarget: asJsonRecord(latest?.effective_airbox_target),
      geometryRealizationRevision:
        latest?.geometry_realization_revision ?? null,
      lastBuildError: boundedDisplayText(latest?.last_build_error),
      lastSuccess: null,
      revision: latest?.revision ?? null,
      sourceSceneRevision: latest?.source_scene_revision ?? null,
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
    reason: string;
    status: "pass" | "fail" | "unknown";
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
  const resolvedTarget = asJsonRecord(summary?.effective_airbox_target);
  const evidenceRevisions = [manifest?.revision, quality?.revision, report?.revision]
    .filter((revision): revision is number => typeof revision === "number");
  const oldestEvidenceRevision = evidenceRevisions.length
    ? Math.min(...evidenceRevisions)
    : null;
  const stale =
    oldestEvidenceRevision !== null && oldestEvidenceRevision < policy.revision;
  const sceneRevision = finiteRevision(currentSceneRevision);
  const sourceSceneRevision = finiteRevision(manifest?.source_scene_revision);
  const sceneEvidenceStale =
    sceneRevision !== null &&
    (sourceSceneRevision === null || sourceSceneRevision !== sceneRevision);
  const reportStatus = stringField(reportRecord, "status");
  const reportReason = stringField(reportRecord, "reason");
  const reportError = stringField(reportRecord, "error");
  const reportDegraded =
    isDegradedBuildStatus(reportStatus) || reportError !== null;
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
    lifecycle: stale || sceneEvidenceStale
      ? {
          reason: sceneEvidenceStale
            ? sourceSceneRevision === null
              ? "Mesh evidence does not publish a source scene revision."
              : `Mesh source scene revision ${sourceSceneRevision} is older than current scene revision ${sceneRevision}.`
            : `Mesh evidence revision ${oldestEvidenceRevision} is older than policy revision ${policy.revision}.`,
          status: "stale",
        }
      : oldestEvidenceRevision === null
        ? { reason: "No realized mesh evidence is available.", status: "missing" }
        : { reason: "Mesh evidence is current with the authored policy.", status: "current" },
    parameters: {
      authored: policy.config ?? null,
      effective: policy.effective_config ?? null,
      resolvedTarget,
    },
    qualityGates: buildAirboxQualityGateModel(qualityRecord, {
      stale: sceneEvidenceStale,
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
  options: { stale?: boolean } = {},
) {
  const scoped = asJsonRecord(quality?.airbox_quality_gates);
  if (!scoped) {
    return {
      evidence: "backend" as const,
      reason: "Airbox-scoped quality gates are not published by the backend.",
      status: "unknown" as const,
    };
  }
  if (options.stale) {
    return {
      evidence: "backend" as const,
      reason: "Airbox quality gates are stale for the current scene revision.",
      status: "unknown" as const,
    };
  }
  const status = stringField(scoped, "status");
  return {
    evidence: "backend" as const,
    reason:
      stringField(scoped, "reason") ??
      (status ? `Backend Airbox gate status is ${status}.` : "Backend did not provide a gate reason."),
    status: status === "pass" ? ("pass" as const) : status === "fail" ? ("fail" as const) : ("unknown" as const),
  };
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
