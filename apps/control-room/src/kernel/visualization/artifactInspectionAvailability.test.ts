import { describe, expect, it } from "vitest";
import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import type { ArtifactFieldSelection } from "./artifactFieldSelection";
import { artifactInspectionAvailability } from "./artifactInspectionAvailability";

const owner: ArtifactFieldSelection = {
  identity: { sessionId: "session", sessionEpoch: "epoch", requestScopeEpoch: "scope" },
  runId: "run", runtimeStageId: "runtime-stage", authoredStageId: "solve", sourceObjectId: "antenna",
};
function execution(state?: "retained" | "absent" | "unknown"): StageExecutionResource {
  return {
    session_id: "session", session_epoch: "epoch", request_scope_epoch: "scope", run_id: "run",
    stages: [{ stage_id: "runtime-stage", antenna_solve_stage_id: "solve", status: "failed",
      ...(state ? { antenna_inspection: { state, reason_code: "test" } } : {}) }],
  } as StageExecutionResource;
}

describe("retained antenna inspection admission", () => {
  it("requires explicit discovery rather than an execution definition or lifecycle", () => {
    for (const state of [undefined, "absent", "unknown"] as const) {
      const result = artifactInspectionAvailability(owner, execution(state));
      expect(result.owner).toBeNull();
      expect(result.state).toBe(state === "absent" ? "absent" : "unknown");
    }
  });
  it("permits a retained result even on a failed legacy execution", () => {
    expect(artifactInspectionAvailability(owner, execution("retained"))).toEqual({ state: "retained", owner });
  });
  it("rejects another session, epoch, scope, run or stage", () => {
    for (const key of ["session_id", "session_epoch", "request_scope_epoch", "run_id"] as const) {
      expect(artifactInspectionAvailability(owner, { ...execution("retained"), [key]: "foreign" }).owner).toBeNull();
    }
    for (const key of ["stage_id", "antenna_solve_stage_id"] as const) {
      const record = execution("retained");
      record.stages[0] = { ...record.stages[0], [key]: "foreign" };
      expect(artifactInspectionAvailability(owner, record).owner).toBeNull();
    }
  });
  it("rejects duplicate and missing owners", () => {
    const duplicate = execution("retained");
    duplicate.stages.push({ ...duplicate.stages[0] });
    expect(artifactInspectionAvailability(owner, duplicate).owner).toBeNull();
    expect(artifactInspectionAvailability(null, execution("retained")).owner).toBeNull();
    expect(artifactInspectionAvailability(owner, null).owner).toBeNull();
  });
});
