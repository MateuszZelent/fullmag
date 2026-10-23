import type { ObservationFrameListResource, ObservationFrameResource } from "../api/apiTypes";

export function observationFramePage(ids: string[], next: string | null = null, runId = "run-a"): ObservationFrameListResource {
  return {
    run_id: runId, next_cursor: next,
    frames: ids.map((id, index): ObservationFrameResource => ({
      schema_version: "observation_frame.v1", frame_id: id, run_id: runId, stage_id: "stage-a",
      task_id: "task-a", attempt_id: "attempt-a", adapter_id: "fdm-cpu", ownership_epoch: 1,
      grid_cells: [2, 2, 1], quantity_ids: ["m"], state_codec_id: "state", state_codec_version: "v1",
      magnetization_href: `/frames/${encodeURIComponent(id)}/m`, status: "complete",
      accepted_state_ref: {
        generation: { runtime_epoch: 1, accepted_revision: index + 1 },
        id: { accepted_step: index, run_id: runId, stage_id: "stage-a", state_digest: `state-${id}`, clock_digest: "clock", domain_digest: "domain", plan_digest: "plan" },
      },
    })),
  };
}
