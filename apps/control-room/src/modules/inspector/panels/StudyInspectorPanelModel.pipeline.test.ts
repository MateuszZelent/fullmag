import { describe, expect, it } from "vitest";
import type { StageExecutionResource } from "@/kernel/api/apiTypes";

import { resolveStudyInspectorModel, studySnapshotFromScene } from "./StudyInspectorPanelModel";

function snapshot() {
  return { ...studySnapshotFromScene(null), stages: ["disabled", "queue"].map((id, index) => ({
    algorithm: null, energyTolerance: null, index, kind: "antenna_field_solve",
    maxSteps: null, stageId: id, pipelineNodeId: id,
    status: index === 0 ? "disabled" : "queued", torqueTolerance: null,
    torqueToleranceFormatted: null, torqueToleranceShortFormatted: null,
    timeBudgetKind: "physical" as const, untilSeconds: null,
  })) };
}

function execution(stageId: string): StageExecutionResource {
  return { active_stage_index: 0, completed_stage_indexes: [], request_scope_epoch: "scope",
    revision: 2, run_id: "run", runtime_state: "running", session_epoch: "epoch", session_id: "session",
    stage_statuses: ["running"], total_stages: 1,
    stages: [{ index: 0, stage_id: stageId, status: "running", converged: false, command_id: "owned-command" }],
  };
}

describe("pipeline telemetry ownership", () => {
  it("matches an active queue ID rather than a shifted authored index", () => {
    const model = resolveStudyInspectorModel({ currentRun: null, snapshot: snapshot(), solverStatus: null,
      stageExecution: execution("queue") });
    expect(model.stages[0].status).toBe("disabled");
    expect(model.stages[0].commandId).toBeNull();
    expect(model.stages[1].commandId).toBe("owned-command");
  });

  it("highlights the authored node of the active compiled execution", () => {
    const stageExecution = execution("script-execution-preparation");
    stageExecution.stages[0] = {
      ...stageExecution.stages[0],
      authored_stage_id: "queue",
    };
    const model = resolveStudyInspectorModel({
      currentRun: null,
      snapshot: snapshot(),
      solverStatus: null,
      stageExecution,
    });

    expect(model.runtime.activeStageLabel).toBe(model.stages[1].label);
    expect(model.selectedStage?.index).toBe(1);
    expect(model.stages[1].status).toBe("running");
    expect(model.stages.map((stage) => stage.active)).toEqual([false, true]);
    expect(model.stages[1].stageId).toBe("script-execution-preparation");
    expect(model.stages[0].status).toBe("disabled");
  });

  it("does not attach an unrelated runtime entry via index fallback", () => {
    const model = resolveStudyInspectorModel({ currentRun: null, snapshot: snapshot(), solverStatus: null,
      stageExecution: execution("definition-not-queue") });
    expect(model.stages.map((stage) => stage.commandId)).toEqual([null, null]);
    expect(model.stages.map((stage) => stage.status)).toEqual(["disabled", "queued"]);
  });
});
