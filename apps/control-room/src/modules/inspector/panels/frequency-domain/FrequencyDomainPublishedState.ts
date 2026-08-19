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
  qualification: FrequencyDomainQualificationState;
  resource: ResourceStatus;
  retainedLastValid: boolean;
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
  const artifact = frequencyDomainArtifactState(data);

  return {
    artifact,
    binding,
    qualification: "unknown",
    resource: resourceStatus,
    retainedLastValid:
      isVerifiedReadySnapshot(data, publishedRevision, binding) &&
      (resourceStatus === "stale" || resourceStatus === "error"),
    source: {
      artifactPath: data?.artifact_path ?? null,
      backend: null,
      contentDigest: data?.content_digest ?? null,
      device: null,
      precision: null,
      provenance: null,
      resourceKey: data?.resource_key ?? selectedResourceKey ?? null,
      runId: runId ?? null,
      schemaVersion: data?.schema_version ?? null,
      stageId: stageId ?? null,
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
): FrequencyDomainArtifactState {
  if (!data) return "missing";
  const status = normalizedArtifactStatus(data.status);
  if (["ready", "complete", "completed", "success", "succeeded"].includes(status)) {
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

function normalizedArtifactStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[-\s]+/g, "_");
}
