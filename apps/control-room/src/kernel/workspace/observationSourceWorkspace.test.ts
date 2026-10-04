import { describe, expect, it } from "vitest";

import type { ObservationFrameResource } from "../api/apiTypes";

import {
  observationSourceWorkspaceStore,
  pinnedObservationSourceFromFrame,
  resetObservationSourceWorkspaceForTests,
} from "./observationSourceWorkspace";

const FRAME = {
  accepted_state_ref: {
    generation: { accepted_revision: 7, runtime_epoch: 3 },
    id: {
      accepted_step: 42,
      clock_digest: "clock",
      domain_digest: "domain",
      plan_digest: "plan",
      run_id: "run-1",
      stage_id: "stage-1",
      state_digest: "state",
    },
  },
  adapter_id: "fdm.cpu.m.v1",
  attempt_id: "attempt-1",
  frame_id: "frame-1",
  grid_cells: [8, 4, 2],
  magnetization_href: "/magnetization",
  ownership_epoch: 5,
  quantity_ids: ["m"],
  run_id: "run-1",
  schema_version: "observation-frame.v1",
  stage_id: "stage-1",
  state_codec_id: "fdm-state",
  state_codec_version: "1",
  status: "complete",
  task_id: "task-1",
} satisfies ObservationFrameResource;

const SESSION = {
  requestScopeEpoch: "scope-1",
  sessionEpoch: "session-epoch-1",
  sessionId: "session-1",
};

describe("observationSourceWorkspaceStore", () => {
  it("pins only the compact exact source identity", () => {
    resetObservationSourceWorkspaceForTests();
    observationSourceWorkspaceStore.pin(
      pinnedObservationSourceFromFrame(FRAME, SESSION),
    );

    expect(observationSourceWorkspaceStore.getSnapshot().pinned).toEqual({
      acceptedRevision: 7,
      acceptedStep: 42,
      adapterId: "fdm.cpu.m.v1",
      frameId: "frame-1",
      runId: "run-1",
      runtimeEpoch: 3,
      sessionIdentityKey: "session-1\u0000session-epoch-1\u0000scope-1",
      stageId: "stage-1",
      stateDigest: "state",
    });
  });

  it("clears a pin when the active session identity changes", () => {
    resetObservationSourceWorkspaceForTests();
    observationSourceWorkspaceStore.pin(
      pinnedObservationSourceFromFrame(FRAME, SESSION),
    );

    observationSourceWorkspaceStore.clearForSession({
      ...SESSION,
      requestScopeEpoch: "scope-2",
    });

    expect(observationSourceWorkspaceStore.getSnapshot().pinned).toBeNull();
  });
});
