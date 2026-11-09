import { describe, expect, it } from "vitest";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import {
  getStageInitialStateChoice,
  matchesPreparedStageInitialState,
  preparedStageInitialStateChoice,
  setStageInitialStateChoice,
  stageInitialStateRequest,
  type StageInitialStateChoice,
} from "./studyStageInitialState";

const historical: StageInitialStateChoice = {
  kind: "stage_result",
  run_id: "run-a",
  step_id: "relax-a",
  case_id: "default",
  artifact_id: "final-state",
  content_sha256: "a".repeat(64),
  allow_stale_model: true,
};

describe("stage initial state intent", () => {
  it("pins a source to its own workspace, stage and scene revision", () => {
    const api = {} as ControlRoomApi;
    setStageInitialStateChoice(api, "scope-a", "relax-b", 7, historical);
    expect(getStageInitialStateChoice(api, "scope-a", "relax-b")).toEqual({
      sceneRevision: 7, choice: historical,
    });
    expect(getStageInitialStateChoice(api, "scope-a", "relax-a")).toBeUndefined();
    expect(getStageInitialStateChoice(api, "scope-b", "relax-b")).toBeUndefined();
    expect(getStageInitialStateChoice({} as ControlRoomApi, "scope-a", "relax-b")).toBeUndefined();
    setStageInitialStateChoice(api, "scope-a", "relax-b", 8, { kind: "default_for_target" });
    expect(getStageInitialStateChoice(api, "scope-a", "relax-b")).toBeUndefined();
  });

  it("binds an authored source to the actual admitted scene and target", () => {
    expect(stageInitialStateRequest({ kind: "authored_stage" }, "relax-b", 8)).toEqual({
      kind: "authored_initial_state", source: { kind: "stage", stage_id: "relax-b", scene_revision: 8 },
    });
    expect(stageInitialStateRequest({ kind: "authored_study" }, "relax-b", 9)).toEqual({
      kind: "authored_initial_state", source: { kind: "study", scene_revision: 9 },
    });
  });

  it("pins a qualified prepared publication without moving it to a new scene", () => {
    const publication = { scene_revision: 8, initial_state_revision: 4, publication_id: "preview-a" };
    const choice = { kind: "prepared", ...publication } as const;
    const readiness = {
      scene_revision: 8,
      prepared_initial_state: {
        ...publication, observation_frame_id: "frame-a", domain_generation_id: "domain-a",
        values_sha256: "a".repeat(64),
      },
    };
    expect(preparedStageInitialStateChoice(readiness, 8)).toEqual(choice);
    expect(preparedStageInitialStateChoice(readiness, 9)).toBeNull();
    expect(stageInitialStateRequest(choice, "relax-b", 8)).toEqual({
      kind: "authored_initial_state", source: choice,
    });
    expect(stageInitialStateRequest(choice, "relax-b", 9)).toBeNull();
    expect(stageInitialStateRequest({ ...choice, initial_state_revision: -1 }, "relax-b", 8)).toBeNull();
    expect(matchesPreparedStageInitialState(choice, { ...choice, publication_id: "preview-b" })).toBe(false);
  });

  it("keeps a pinned result exact and rejects an invalid explicit source", () => {
    expect(stageInitialStateRequest(historical, "relax-b", 9)).toEqual(historical);
    expect(stageInitialStateRequest({ ...historical, content_sha256: "" }, "relax-b", 9)).toBeNull();
    expect(stageInitialStateRequest({ kind: "unknown" }, "relax-b", 9)).toBeNull();
    expect(stageInitialStateRequest(undefined, "relax-b", 9)).toEqual({ kind: "default_for_target" });
  });
});
