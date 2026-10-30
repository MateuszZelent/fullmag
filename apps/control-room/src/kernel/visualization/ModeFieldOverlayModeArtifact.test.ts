import { describe, expect, it } from "vitest";
import type { FrequencyDomainJsonArtifactResource } from "../api/apiTypes";
import type { ModeFieldOverlayIntent } from "./ModeFieldOverlayIntent";
import { ownedModeArtifactGeneration } from "./ModeFieldOverlayModeArtifact";

const intent: ModeFieldOverlayIntent = {
  analysisRunId: "run-1", analysisStageId: "stage-1", artifactRevision: "artifact-1",
  equilibriumId: "sha256:eq-1", fieldId: "analysis:eigen:sample-0:mode-2",
  metadataResourceKey: "metadata", modeId: "mode-2", modeIndex: 2,
  nodeId: "mode-node", sampleId: "sample-0", sampleIndex: 0,
};

function artifact(): FrequencyDomainJsonArtifactResource {
  return {
    schema_version: "frequency_domain_eigen_mode_resource.v1", status: "ready",
    artifact_path: "eigen/modes/sample_0000/mode_0002.json", resource_key: "mode",
    revision: "sha256:mode-1", generation_id: "sha256:generation-1",
    generation_status: "member_verified_owner_bound", run_id: "run-1", stage_id: "stage-1",
    payload: {
      schema_version: "eigen_mode.v2", sample_index: 0, raw_mode_index: 2,
      mode_field_id: intent.fieldId, equilibrium_artifact_sha256: intent.equilibriumId,
      candidate_identity: {
        schema_version: "modal_candidate_identity.v1", source_identity: {},
        equilibrium_artifact_sha256: intent.equilibriumId,
      },
    },
  } as FrequencyDomainJsonArtifactResource;
}

function withPayload(patch: Record<string, unknown>): FrequencyDomainJsonArtifactResource {
  const value = artifact();
  return { ...value, payload: { ...value.payload, ...patch } } as FrequencyDomainJsonArtifactResource;
}

describe("owned mode artifact generation", () => {
  it("accepts only the exact owned mode and its sample equilibrium", () => {
    expect(ownedModeArtifactGeneration(intent, artifact())).toBe("sha256:generation-1");
    expect(ownedModeArtifactGeneration({ ...intent, equilibriumId: undefined }, artifact())).toBeNull();
  });

  it.each([
    ["run", { ...artifact(), run_id: "foreign" }],
    ["stage", { ...artifact(), stage_id: "foreign" }],
    ["missing wrapper owner", { ...artifact(), stage_id: null }],
    ["unbound generation", { ...artifact(), generation_status: "member_verified_unbound" }],
    ["legacy", { ...artifact(), generation_status: "legacy_unverified", generation_id: null }],
    ["missing generation", { ...artifact(), generation_id: null }],
    ["wrong resource schema", { ...artifact(), schema_version: "other" }],
    ["missing revision", { ...artifact(), revision: null, content_digest: null }],
    ["sample index", withPayload({ sample_index: 1 })],
    ["raw mode index", withPayload({ raw_mode_index: 3 })],
    ["missing raw mode index", withPayload({ raw_mode_index: undefined })],
    ["field id", withPayload({ mode_field_id: "other-field" })],
    ["top equilibrium", withPayload({ equilibrium_artifact_sha256: "sha256:eq-other" })],
    ["missing top equilibrium", withPayload({ equilibrium_artifact_sha256: undefined })],
    ["candidate equilibrium", withPayload({ candidate_identity: { equilibrium_artifact_sha256: "sha256:eq-other" } })],
    ["missing candidate", withPayload({ candidate_identity: undefined })],
    ["malformed candidate", withPayload({ candidate_identity: [] })],
    ["payload owner conflict", withPayload({ run_id: "foreign" })],
    ["stable sample conflict", withPayload({ sample_id: "other-sample" })],
    ["stable mode conflict", withPayload({ mode_id: "other-mode" })],
  ])("rejects %s", (_label, invalid) => {
    expect(ownedModeArtifactGeneration(intent, invalid as FrequencyDomainJsonArtifactResource)).toBeNull();
  });
});
