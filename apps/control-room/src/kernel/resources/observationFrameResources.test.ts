import { describe, expect, it } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";

import type { ObservationFrameResource } from "../api/apiTypes";
import {
  DATA_OBSERVATION_FRAMES_PATH,
  DATA_OBSERVATION_FRAME_PATH,
  DATA_OBSERVATION_FRAME_MAGNETIZATION_PATH,
} from "../api/apiPaths";

import {
  handleAbsentObservationFrameStore,
  observationFrameListQuery,
  observationFrameListResourceKey,
  observationFrameListRevision,
  observationFrameMagnetizationResourceKey,
  observationFrameMagnetizationRevision,
  observationFrameResourceKey,
  observationFrameRevision,
} from "./observationFrameResources";

const frame: ObservationFrameResource = {
  accepted_state_ref: {
    generation: { accepted_revision: 29, runtime_epoch: 7 },
    id: {
      accepted_step: 41,
      clock_digest: "sha256:clock",
      domain_digest: "sha256:domain",
      plan_digest: "sha256:plan",
      run_id: "run-a",
      stage_id: "stage-a",
      state_digest: "sha256:state",
    },
  },
  adapter_id: "fdm-cpu",
  attempt_id: "attempt-a",
  frame_id: "frame-a/b",
  grid_cells: [4, 2, 1],
  magnetization_href:
    DATA_OBSERVATION_FRAME_MAGNETIZATION_PATH.replace("{frame_id}", "frame-a%2Fb"),
  ownership_epoch: 3,
  quantity_ids: ["m"],
  run_id: "run-a",
  schema_version: "observation_frame.v1",
  stage_id: "stage-a",
  state_codec_id: "fullmag.fdm_cpu.observation_state",
  state_codec_version: "v1",
  status: "complete",
  task_id: "task-a",
};

describe("observation frame resource identity", () => {
  it("normalizes and orders the immutable list query", () => {
    const query = observationFrameListQuery({
      cursor: " frame-1 ",
      limit: 25,
      runId: " run-a ",
      stageId: " stage-a ",
    });

    expect(query).toEqual({
      cursor: "frame-1",
      limit: 25,
      run_id: "run-a",
      stage_id: "stage-a",
    });
    expect(observationFrameListResourceKey(query)).toBe(
      `${DATA_OBSERVATION_FRAMES_PATH}?run_id=run-a&stage_id=stage-a&cursor=frame-1&limit=25`,
    );
  });

  it("encodes frame identity in descriptor and heavy-field keys", () => {
    expect(observationFrameResourceKey(frame.frame_id)).toBe(
      DATA_OBSERVATION_FRAME_PATH.replace("{frame_id}", "frame-a%2Fb"),
    );
    expect(observationFrameMagnetizationResourceKey(frame.frame_id)).toBe(
      DATA_OBSERVATION_FRAME_MAGNETIZATION_PATH.replace("{frame_id}", "frame-a%2Fb"),
    );
  });

  it("keeps runtime epoch and accepted revision in resource freshness", () => {
    expect(observationFrameRevision(frame)).toBe("frame-a/b:7:29");
    expect(
      observationFrameListRevision({
        frames: [frame],
        next_cursor: "frame-next",
        run_id: "run-a",
      }),
    ).toBe("run-a|frame-a/b:7:29|frame-next");
  });

  it("prefers the exact field generation over transport ETag", () => {
    expect(
      observationFrameMagnetizationRevision({
        byteLength: 24,
        data: {
          dtype: "float64",
          fieldGenerationId: "field:frame-a:m:29",
          formatVersion: 4,
          grid: [1, 1, 1],
          nComp: 3,
          pointCount: 1,
          quantityId: "m",
          sourceId: "frame-a",
          sourceKind: "observation_frame",
          sourceRevision: "29",
          valueCount: 3,
          values: new Float64Array([1, 0, 0]),
        },
        etag: '"etag-a"',
        responseMetadata: {
          component: null,
          domainGenerationId: "sha256:domain",
          encoding: "FMVP;version=4",
          fieldGenerationId: "field:frame-a:m:29",
          fieldIndexing: "full_domain",
          fieldRevision: null,
          identityIssues: [],
          meshTopologyHash: "00".repeat(32),
          nComp: 3,
          nodeIndexCount: 0,
          pointCount: 1,
          quantityId: "m",
          scopeId: null,
          scopeKind: "full",
          snapshotId: null,
          sourceId: "frame-a",
          sourceKind: "observation_frame",
          sourceRevision: "29",
          valueCount: 3,
        },
        status: "ready",
      }),
    ).toBe("field:frame-a:m:29");
  });
});


describe("optional observation store absence", () => {
  it("allows only the exact published optional store absence", () => {
    expect(handleAbsentObservationFrameStore(new ControlRoomApiError(
      "durable observation run storage was not found", 404, null, "not_found",
    ))).toBeNull();
  });
  it("retains generic missing frames and real storage failures", () => {
    for (const error of [
      new ControlRoomApiError("frame was not found", 404, null, "not_found"),
      new ControlRoomApiError("durable observation run storage was not found", 500, null, "not_found"),
      new ControlRoomApiError("permission denied", 500, null, "internal_error"),
      new ControlRoomApiError("corrupt store", 500, null, "internal_error"),
    ]) expect(() => handleAbsentObservationFrameStore(error)).toThrow(error);
  });
});
