import { describe, expect, it } from "vitest";

import type { ObservationFrameListResource } from "@/kernel/api/apiTypes";

import { buildPhysicsFirstResultsTree } from "./builders/resultsExplorerNodes";
import { flattenExplorerNodes } from "./builders/buildModelTree";
import { selectionRefFromNode } from "./explorerSelection";

const FRAMES = {
  frames: [
    {
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
    },
  ],
  run_id: "run-1",
} satisfies ObservationFrameListResource;

describe("observation frame Explorer contract", () => {
  it("publishes immutable frames under Dynamics and maps exact selection identity", () => {
    const nodes = flattenExplorerNodes(buildPhysicsFirstResultsTree({
      entries: [],
      observationFrames: {
        data: FRAMES,
        error: null,
        missing: false,
        revision: "frames-r1",
        status: "ready",
      },
      pinnedObservationFrameId: "frame-1",
      resultContextRunId: "run-1",
    }));
    const frame = nodes.find((node) => node.kind === "results.observation_frame");

    expect(frame).toMatchObject({ badge: "pinned", label: "Step 42" });
    expect(selectionRefFromNode(frame!)).toEqual({
      acceptedRevision: 7,
      acceptedStep: 42,
      adapterId: "fdm.cpu.m.v1",
      frameId: "frame-1",
      kind: "results.observation_frame",
      nodeId: "results:run:run-1:dynamics:observation-frames:frame-1",
      runId: "run-1",
      runtimeEpoch: 3,
      stageId: "stage-1",
      stateDigest: "state",
      type: "observation-frame",
    });
  });
});
