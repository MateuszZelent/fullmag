import { describe, expect, it, vi } from "vitest";

import type { AntennaExternalLeadInspectionResource } from "@/kernel/api/apiTypes";
import type { ArtifactFieldSelection } from "@/kernel/visualization/artifactFieldSelection";
import { recordedAirboxFieldIntent } from "./recordedAirboxFieldModel";

vi.mock("@/kernel/resources/antennaClosedLoopInspectionModel", () => ({
  closedLoopManifest: (record: { closed_loop_manifest: unknown }) => record.closed_loop_manifest,
}));

const source: ArtifactFieldSelection = {
  identity: { sessionId: "session", sessionEpoch: "epoch", requestScopeEpoch: "scope" },
  runtimeStageId: "stage-000",
  authoredStageId: "inspect-cpw",
  sourceObjectId: "antenna",
  runId: "run",
};

function inspection(domain = "global"): AntennaExternalLeadInspectionResource {
  return {
    status: "inspection_only", session_id: "session", session_epoch: "epoch", request_scope_epoch: "scope",
    run_id: "run", runtime_stage_id: "stage-000", stage_id: "inspect-cpw", stage_revision: 1,
    output_id: "inspection", port_mode_id: "port", record_content_digest: "sha256:record",
    closed_loop_manifest: {
      source_object_id: "antenna", content_digest: "sha256:payload",
      sample_carrier: { domain: { kind: domain }, carrier_kind: "fem_domain_mesh_asset", location: "node" },
    },
    outputs: [{ inspection_ref: { stage_id: "inspect-cpw", output_id: "inspection", content_digest: "sha256:payload" } }],
  } as unknown as AntennaExternalLeadInspectionResource;
}

describe("recorded Airbox H display", () => {
  it("uses the pinned global sampling mesh with recorded SI magnetic-field vectors", () => {
    expect(recordedAirboxFieldIntent(source, inspection())).toMatchObject({
      kind: "inspection", quantity: "magnetic_field", solutionId: "inspection",
      runId: "run", vectors: true, wireframe: true, contentDigest: "sha256:payload",
    });
  });

  it("rejects an object-only mesh or an inspection from a different run", () => {
    expect(recordedAirboxFieldIntent(source, inspection("object"))).toBeNull();
    expect(recordedAirboxFieldIntent({ ...source, runId: "other" }, inspection())).toBeNull();
  });
});
