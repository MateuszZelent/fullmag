import type { StudyStageResult } from "@/kernel/api/apiTypes";
import { stageInitialStateRequest, type StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";

type ResultChoice = Extract<StageInitialStateChoice, { kind: "stage_result" }>;

export function stageResultInitialState(result: StudyStageResult): ResultChoice | null {
  if (!result.supports_magnetization_input) return null;
  const request = stageInitialStateRequest({
    kind: "stage_result",
    run_id: result.source.run_id,
    step_id: result.source.step_id,
    case_id: result.source.case_id,
    artifact_id: result.artifact_id,
    content_sha256: result.artifact_sha256,
    allow_stale_model: false,
  }, result.source.step_id, 0);
  return request?.kind === "stage_result" ? request : null;
}
