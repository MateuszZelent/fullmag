import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

export type FrequencyDomainArtifactState =
  | "complete"
  | "partial"
  | "interrupted"
  | "missing"
  | "corrupt"
  | "unknown";

export type FrequencyDomainQualificationState =
  | "qualified"
  | "unqualified"
  | "unknown"
  | "unsupported";

export interface FrequencyDomainPublishedState {
  artifact: FrequencyDomainArtifactState;
  binding: "compatible" | "incompatible" | "unbound";
  fields: "available" | "unavailable" | "unknown";
  qualification: FrequencyDomainQualificationState;
  resource: ResourceStatus;
  retainedLastValid: boolean;
  solve: "succeeded" | "failed" | "unknown";
  spectrum: string;
  window: "complete" | "incomplete" | "not_applicable" | "unknown";
  source: {
    artifactPath: string | null;
    backend: string | null;
    contentDigest: string | null;
    device: string | null;
    precision: string | null;
    provenance: string | null;
    resourceKey: string | null;
    runId: string | null;
    schemaVersion: string | null;
    stageId: string | null;
    meshGenerationId: string | null;
  };
}

export function frequencyDomainPublishedState({
  data,
  publishedRevision,
  resourceStatus,
  runId,
  selectedResourceKey,
  selectedRevision,
  stageId,
}: {
  data: FrequencyDomainJsonArtifactResource | null;
  publishedRevision: string | number | null;
  resourceStatus: ResourceStatus;
  runId?: string | null;
  selectedResourceKey?: string | null;
  selectedRevision?: string | null;
  stageId?: string | null;
}): FrequencyDomainPublishedState {
  const hasSelection = selectedResourceKey != null || selectedRevision != null;
  const resourceMismatch =
    selectedResourceKey != null &&
    data != null &&
    selectedResourceKey !== data.resource_key;
  const revisionMismatch =
    selectedRevision != null &&
    publishedRevision != null &&
    selectedRevision !== String(publishedRevision);
  const missingSelectedRevision =
    hasSelection && data != null && publishedRevision == null;
  const binding = !hasSelection || data == null
    ? "unbound"
    : resourceMismatch || revisionMismatch || missingSelectedRevision
      ? "incompatible"
      : "compatible";
  const payload = objectRecord(data?.payload);
  const candidateIdentity = objectRecord(payload?.candidate_identity);
  const solveSucceeded = booleanValue(payload?.solve_succeeded);
  const fieldsAvailable = booleanValue(payload?.fields_available);
  const spectrumCompleteness = stringValue(payload?.spectrum_completeness);
  const windowComplete = booleanValue(payload?.window_complete);
  const validationState = normalizedOptionalStatus(payload?.validation_state);
  const artifact = frequencyDomainArtifactState(
    data,
    solveSucceeded,
    spectrumCompleteness,
    windowComplete,
  );

  return {
    artifact,
    binding,
    fields:
      fieldsAvailable == null
        ? "unknown"
        : fieldsAvailable
          ? "available"
          : "unavailable",
    qualification: qualificationState(validationState),
    resource: resourceStatus,
    retainedLastValid:
      isVerifiedReadySnapshot(data, publishedRevision, binding) &&
      (resourceStatus === "stale" || resourceStatus === "error"),
    solve:
      solveSucceeded == null
        ? "unknown"
        : solveSucceeded
          ? "succeeded"
          : "failed",
    spectrum: spectrumCompleteness ?? "unknown",
    window:
      windowComplete == null
        ? spectrumCompleteness === "selected_only"
          ? "not_applicable"
          : "unknown"
        : windowComplete
          ? "complete"
          : "incomplete",
    source: {
      artifactPath: data?.artifact_path ?? null,
      backend:
        stringValue(payload?.engine_id) ??
        stringValue(candidateIdentity?.engine_id),
      contentDigest: data?.content_digest ?? null,
      device: stringValue(candidateIdentity?.device),
      precision: null,
      provenance: stringValue(
        objectRecord(candidateIdentity?.source_identity)?.source_snapshot_sha256,
      ),
      resourceKey: data?.resource_key ?? selectedResourceKey ?? null,
      runId: data?.run_id ?? runId ?? null,
      schemaVersion: data?.schema_version ?? null,
      stageId: data?.stage_id ?? stageId ?? null,
      meshGenerationId:
        data?.mesh_generation_id ??
        stringValue(candidateIdentity?.mesh_generation_id),
    },
  };
}

function isVerifiedReadySnapshot(
  data: FrequencyDomainJsonArtifactResource | null,
  publishedRevision: string | number | null,
  binding: FrequencyDomainPublishedState["binding"],
): boolean {
  return Boolean(
    data &&
    normalizedArtifactStatus(data.status) === "ready" &&
    data.artifact_path.trim() &&
    data.resource_key.trim() &&
    data.schema_version.trim() &&
    publishedRevision != null &&
    binding !== "incompatible",
  );
}

function frequencyDomainArtifactState(
  data: FrequencyDomainJsonArtifactResource | null,
  solveSucceeded: boolean | null,
  spectrumCompleteness: string | null,
  windowComplete: boolean | null,
): FrequencyDomainArtifactState {
  if (!data) return "missing";
  if (solveSucceeded === false) return "corrupt";
  const status = normalizedArtifactStatus(data.status);
  if (["ready", "complete", "completed", "success", "succeeded"].includes(status)) {
    if (
      windowComplete === false ||
      (spectrumCompleteness != null &&
        !["complete", "certified_window"].includes(
          normalizedArtifactStatus(spectrumCompleteness),
        ))
    ) {
      return "partial";
    }
    return "complete";
  }
  if (["corrupt", "error", "failed", "invalid", "malformed"].includes(status)) {
    return "corrupt";
  }
  if (["missing", "absent", "not_found", "unavailable"].includes(status)) {
    return "missing";
  }
  if (["interrupted", "cancelled", "canceled"].includes(status)) {
    return "interrupted";
  }
  if (["partial", "incomplete"].includes(status)) return "partial";
  return "unknown";
}

function qualificationState(
  validationState: string | null,
): FrequencyDomainQualificationState {
  if (validationState == null) return "unknown";
  if (["qualified", "validated", "certified"].includes(validationState)) {
    return "qualified";
  }
  if (["unsupported", "not_supported"].includes(validationState)) {
    return "unsupported";
  }
  return "unqualified";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizedOptionalStatus(value: unknown): string | null {
  const text = stringValue(value);
  return text == null ? null : normalizedArtifactStatus(text);
}

function normalizedArtifactStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[-\s]+/g, "_");
}
