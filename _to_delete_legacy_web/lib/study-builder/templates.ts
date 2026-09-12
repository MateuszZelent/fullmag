import type { StudyPipelineDocument } from "./types";

export function createGroundStateTemplate(): StudyPipelineDocument {
  return {
    version: "study_pipeline.v1",
    nodes: [
      {
        id: "relax_1",
        label: "Relax",
        enabled: true,
        node_kind: "primitive",
        stage_kind: "relax",
        payload: {
          kind: "relax",
          relax_algorithm: "llg_overdamped",
          max_steps: "5000",
          torque_tolerance: "1e-4",
        },
      },
    ],
  };
}
