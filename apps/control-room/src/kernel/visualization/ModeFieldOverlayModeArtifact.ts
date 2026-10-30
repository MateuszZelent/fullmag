import type { FrequencyDomainJsonArtifactResource } from "../api/apiTypes";
import type { ModeFieldOverlayIntent } from "./ModeFieldOverlayIntent";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exact(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Returns the committed generation only after the owned mode proves the full
 * selection identity. Unknown or missing evidence never borrows another sample. */
export function ownedModeArtifactGeneration(
  intent: ModeFieldOverlayIntent,
  artifact: FrequencyDomainJsonArtifactResource | null | undefined,
): string | null {
  const expectedEquilibrium = exact(intent.equilibriumId);
  const generation = exact(artifact?.generation_id);
  const payload = record(artifact?.payload);
  if (
    !expectedEquilibrium || !generation || !payload ||
    artifact?.status !== "ready" ||
    artifact.schema_version !== "frequency_domain_eigen_mode_resource.v1" ||
    artifact.generation_status !== "member_verified_owner_bound" ||
    !exact(artifact.revision ?? artifact.content_digest) ||
    artifact.run_id !== intent.analysisRunId ||
    artifact.stage_id !== intent.analysisStageId ||
    payload.sample_index !== intent.sampleIndex ||
    payload.raw_mode_index !== intent.modeIndex ||
    payload.mode_field_id !== intent.fieldId ||
    payload.equilibrium_artifact_sha256 !== expectedEquilibrium
  ) {
    return null;
  }
  const candidate = record(payload.candidate_identity);
  if (!candidate || candidate.equilibrium_artifact_sha256 !== expectedEquilibrium) return null;
  for (const [key, expected] of [
    ["run_id", intent.analysisRunId], ["stage_id", intent.analysisStageId],
    ["sample_id", intent.sampleId], ["mode_id", intent.modeId],
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== expected) return null;
  }
  // Some publications repeat identity evidence on the resource envelope. It
  // must agree when present, rather than overriding the owned payload.
  const envelope = artifact as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(envelope, "equilibrium_artifact_sha256") &&
    envelope.equilibrium_artifact_sha256 !== expectedEquilibrium) return null;
  if (Object.prototype.hasOwnProperty.call(envelope, "candidate_identity")) {
    const envelopeCandidate = record(envelope.candidate_identity);
    if (!envelopeCandidate || envelopeCandidate.equilibrium_artifact_sha256 !== expectedEquilibrium) return null;
  }
  return generation;
}
