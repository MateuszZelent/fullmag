import type { StageExecutionResource } from "@/kernel/api/apiTypes";

type RuntimeStage = StageExecutionResource["stages"][number];

export function runtimeStageOwnerId(stage: RuntimeStage): string {
  return stage.authored_stage_id ?? stage.stage_id;
}

export function runtimeStagesByOwner(stageExecution: StageExecutionResource | null) {
  const stages = new Map<string, RuntimeStage>();
  for (const stage of stageExecution?.stages ?? []) {
    const ownerId = runtimeStageOwnerId(stage);
    const previous = stages.get(ownerId);
    // When a macro expands into multiple executions, surface the active one.
    if (!previous || previous.index !== stageExecution?.active_stage_index) {
      stages.set(ownerId, stage);
    }
  }
  return stages;
}
