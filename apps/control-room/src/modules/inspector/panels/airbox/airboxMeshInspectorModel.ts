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
import { boundedDisplayText, boundedItems } from "./airboxDisplay";

type AirboxMeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

type JsonRecord = Record<string, unknown>;

export interface AirboxMeshBuildModel {
  buildMode: string | null;
  effectiveAirboxTarget: JsonRecord | null;
  fallbacks: readonly string[];
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
  sourceSceneRevision: number | null;
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
  latest = null,
  report,
}: {
  current: MeshActiveBuildResource | null;
  latest?: MeshLastSuccessfulBuildResource | null;
  report: MeshUniverseReportResource | null;
}): AirboxMeshBuildModel {
  const reportRecord = asJsonRecord(report?.report);
  const reportStatus = stringField(reportRecord, "status");
  const buildReport = current?.shared_domain_build_report ?? null;
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
  return {
    buildMode: boundedDisplayText(buildReport?.build_mode),
    effectiveAirboxTarget: asJsonRecord(
      buildReport?.effective_airbox_target ?? current?.effective_airbox_target,
    ),
    fallbacks: fallbacks.map((fallback) => boundedDisplayText(fallback) ?? ""),
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
      sourceSceneRevision: current?.provenance?.source_scene_revision ?? null,
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
    sourceSceneRevision: current?.source_scene_revision ?? null,
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
    surfaceFaceCount: number | null;
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
    parts.find((part) => part.role === "air" || part.role === "airbox") ??
    parts.find((part) => part.id === "part:__air__") ??
    parts.find((part) => part.label.trim().toLowerCase() === "airbox") ??
    null
  );
}

export function buildAirboxMeshInspectorModel({
  manifest,
  policy,
  quality,
  report,
  summary,
}: {
  manifest: MeshSharedDomainManifestResource | null;
  policy: MeshUniverseConfigResource;
  quality: MeshUniverseQualityResource | null;
  report: MeshUniverseReportResource | null;
  summary: MeshSummaryResource | null;
}): AirboxMeshInspectorModel {
  const airboxPart = findCanonicalAirboxPart(manifest?.mesh_parts);
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
  const reportStatus = stringField(reportRecord, "status");
  const reportReason = stringField(reportRecord, "reason");
  const reportError = stringField(reportRecord, "error");
  const reportDegraded =
    isDegradedBuildStatus(reportStatus) || reportError !== null;

  return {
    airboxPart,
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
    lifecycle: stale
      ? {
          reason: `Mesh evidence revision ${oldestEvidenceRevision} is older than policy revision ${policy.revision}.`,
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
    qualityGates: buildAirboxQualityGateModel(qualityRecord),
    statistics: {
      boundaryFaceCount: airboxPart?.boundary_face_count ?? null,
      elementCount: airboxPart?.element_count ?? null,
      nodeCount: airboxPart?.node_count ?? null,
      surfaceFaceCount: airboxPart?.surface_faces?.length ?? null,
    },
    topology: {
      bounds:
        airboxPart?.bounds_min && airboxPart.bounds_max
          ? { max: airboxPart.bounds_max, min: airboxPart.bounds_min }
          : null,
      sharedInterfaceNodes: {
        count: numericField(reportRecord, "shared_interface_node_count"),
        label: "Shared interface nodes",
        ownership: "shared",
      },
    },
  };
}

function buildAirboxQualityGateModel(quality: JsonRecord | null) {
  const scoped = asJsonRecord(quality?.airbox_quality_gates);
  if (!scoped) {
    return {
      evidence: "backend" as const,
      reason: "Airbox-scoped quality gates are not published by the backend.",
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
