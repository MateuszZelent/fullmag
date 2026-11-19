import { describe, expect, it } from "vitest";

import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

import { createPipelineStudyStageDrafts } from "./studyPipelineStageDrafts";

const relaxPayload = {
  adaptive_timestep: null,
  entrypoint_kind: "flat_relax",
  fixed_timestep: "1e-14",
  integrator: "heun",
  kind: "relax",
  max_relaxation_time_s: "1e-09",
  max_steps: "100000",
  relax_algorithm: "llg_overdamped",
  stage_id: "joint_relax",
  torque_tolerance: "7.95774715459",
};

function pipelineStudy(nodes: unknown[]) {
  return { study_pipeline: { version: "study_pipeline.v1", nodes } };
}

describe("createPipelineStudyStageDrafts", () => {
  it("parses a script-imported relax primitive into a typed read-only draft", () => {
    const source = readStudyStageSource(pipelineStudy([
      {
        enabled: true,
        id: "joint_relax",
        label: "Relax 1",
        node_kind: "primitive",
        payload: relaxPayload,
        stage_kind: "relax",
      },
    ]));
    const [draft] = createPipelineStudyStageDrafts(source.entries);

    expect(draft).toMatchObject({
      algorithm: "llg_overdamped",
      dt: "1e-14",
      kind: "relax",
      maxRelaxationTime: "1e-09",
      maxSteps: "100000",
      pipelineNodeId: "joint_relax",
      rawStage: relaxPayload,
      solver: "heun",
      stageId: "joint_relax",
      timestepMode: "fixed",
      torqueTolerance: "7.95774715459",
    });
  });

  it("uses the canonical stage_kind when the payload omits kind", () => {
    const source = readStudyStageSource(pipelineStudy([
      {
        id: "first",
        node_kind: "primitive",
        payload: { until_seconds: 1e-12 },
        stage_kind: "run",
      },
    ]));
    expect(createPipelineStudyStageDrafts(source.entries)[0]).toMatchObject({
      kind: "run",
      pipelineNodeId: "first",
      rawStage: { until_seconds: 1e-12 },
    });
  });

  it("keeps macros and primitives without a typed draft unsupported", () => {
    const source = readStudyStageSource(pipelineStudy([
      { id: "macro", node_kind: "macro", macro_kind: "sweep", config: { n: 3 } },
      { id: "load", node_kind: "primitive", stage_kind: "load_state", payload: { path: "x" } },
    ]));
    const drafts = createPipelineStudyStageDrafts(source.entries);

    expect(drafts.map((draft) => draft.kind)).toEqual(["unsupported", "unsupported"]);
    expect(drafts[0]?.rawStage).toEqual({ n: 3 });
    expect(drafts[1]?.rawStage).toEqual({ path: "x" });
  });
});
