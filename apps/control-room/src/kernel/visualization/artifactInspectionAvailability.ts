import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import type { ArtifactFieldSelection } from "./artifactFieldSelection";

/** Registry discovery permits a catalog read; it does not qualify field payloads. */
export function artifactInspectionAvailability(
  selection: ArtifactFieldSelection | null,
  execution: StageExecutionResource | null,
): { state: "retained" | "absent" | "unknown"; owner: ArtifactFieldSelection | null } {
  if (!selection || !execution ||
      execution.session_id !== selection.identity.sessionId ||
      execution.session_epoch !== selection.identity.sessionEpoch ||
      execution.request_scope_epoch !== selection.identity.requestScopeEpoch ||
      execution.run_id !== selection.runId) return { state: "unknown", owner: null };
  const stages = execution.stages.filter(stage =>
    stage.stage_id === selection.runtimeStageId &&
    stage.antenna_solve_stage_id === selection.authoredStageId);
  if (stages.length !== 1) return { state: "unknown", owner: null };
  const state = stages[0].antenna_inspection?.state;
  return state === "retained" ? { state, owner: selection }
    : { state: state === "absent" ? state : "unknown", owner: null };
}
