import { describe, expect, it } from "vitest";

import type { AntennaExternalLeadInspectionResource } from "@/kernel/api/apiTypes";
import { antennaInspectionIntentMatchesOwner, type AntennaFieldIntent } from "./antennaFieldIntent";

const intent: AntennaFieldIntent = {
  kind: "inspection", sessionId: "session", sessionEpoch: "epoch", requestScopeEpoch: "scope",
  sourceObjectId: "antenna", stageId: "solve-definition", runtimeStageId: "runtime-segment", runId: "run",
  solutionId: "output", contentDigest: "sha256:payload", portModeId: "port",
  recordContentDigest: "sha256:record", stageRevision: 3, quantity: "magnetic_field",
  points: true, vectors: false, component: "magnitude", palette: "viridis",
};
const inspection = {
  status: "inspection_only", qualification: "NOT VERIFIED", field_scope: "external_electrode_truncation",
  session_id: "session", session_epoch: "epoch", request_scope_epoch: "scope", run_id: "run",
  stage_id: "solve-definition", runtime_stage_id: "runtime-segment", stage_revision: 3,
  record_content_digest: "sha256:record", output_id: "output", port_mode_id: "port",
  manifest: { source_object_id: "antenna", content_digest: "sha256:payload" },
  outputs: [{ inspection_ref: { stage_id: "solve-definition", output_id: "output", content_digest: "sha256:payload" } }],
} as unknown as AntennaExternalLeadInspectionResource;

describe("antenna inspection display execution identity", () => {
  it("preserves distinct authored and runtime IDs without a fallback", () => {
    expect(antennaInspectionIntentMatchesOwner(intent, inspection)).toBe(true);
    expect(antennaInspectionIntentMatchesOwner({ ...intent, runtimeStageId: intent.stageId }, inspection)).toBe(false);
    expect(antennaInspectionIntentMatchesOwner({ ...intent, runtimeStageId: undefined }, inspection)).toBe(false);
    expect(antennaInspectionIntentMatchesOwner({ ...intent, runId: undefined }, inspection)).toBe(false);
  });

  it("rejects stale run, scope, revision, record, output and source identities", () => {
    for (const patch of [
      { runId: "other" }, { requestScopeEpoch: "other" }, { sessionEpoch: "other" }, { sessionId: "other" },
      { stageId: "other" }, { sourceObjectId: "other" }, { stageRevision: 4 }, { recordContentDigest: "other" },
      { solutionId: "other" }, { contentDigest: "other" }, { portModeId: "other" },
    ]) expect(antennaInspectionIntentMatchesOwner({ ...intent, ...patch }, inspection)).toBe(false);
  });

  it("does not display cancelled, basis, missing or mismatched publication", () => {
    expect(antennaInspectionIntentMatchesOwner(intent, { ...inspection, status: "cancelled" })).toBe(false);
    expect(antennaInspectionIntentMatchesOwner({ ...intent, kind: "basis" }, inspection)).toBe(false);
    expect(antennaInspectionIntentMatchesOwner(intent, { ...inspection, outputs: [] })).toBe(false);
    for (const patch of [{ stage_id: "other" }, { output_id: "other" }, { stage_id: undefined }, { output_id: undefined }]) {
      expect(antennaInspectionIntentMatchesOwner(intent, {
        ...inspection,
        outputs: [{ ...inspection.outputs[0], inspection_ref: { ...inspection.outputs[0].inspection_ref, ...patch } }],
      } as unknown as AntennaExternalLeadInspectionResource)).toBe(false);
    }
    expect(antennaInspectionIntentMatchesOwner(intent, { ...inspection, outputs: [{ ...inspection.outputs[0], inspection_ref: { ...inspection.outputs[0].inspection_ref, content_digest: "other" } }] })).toBe(false);
  });
});
