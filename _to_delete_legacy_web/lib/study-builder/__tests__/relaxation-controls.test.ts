import { describe, expect, it } from "vitest";

import { materializeStudyPipeline } from "../materialize";
import { createGroundStateTemplate } from "../templates";
import { validateStudyPipeline } from "../validate";
import type { StudyPipelineDocument } from "../types";

describe("study builder relaxation controls", () => {
  it("materializes adaptive error and relax time budgets", () => {
    const document: StudyPipelineDocument = {
      version: "study_pipeline.v1",
      nodes: [
        {
          id: "relax-1",
          label: "Relax",
          enabled: true,
          node_kind: "primitive",
          stage_kind: "relax",
          payload: {
            kind: "relax",
            entrypoint_kind: "relax",
            integrator: "rk23",
            max_error: "1e-6",
            max_pseudotime_s: "1e-9",
            max_physical_time_s: "5e-9",
          },
        },
      ],
    };

    const materialized = materializeStudyPipeline(document);

    expect(materialized.stages[0]).toMatchObject({
      integrator: "rk23",
      max_error: "1e-6",
      max_pseudotime_s: "1e-9",
      max_physical_time_s: "5e-9",
    });
  });

  it("rejects tangent-plane implicit as a current executable UI choice", () => {
    const document: StudyPipelineDocument = {
      version: "study_pipeline.v1",
      nodes: [
        {
          id: "relax-1",
          label: "Relax",
          enabled: true,
          node_kind: "primitive",
          stage_kind: "relax",
          payload: {
            kind: "relax",
            relax_algorithm: "tangent_plane_implicit",
          },
        },
      ],
    };

    expect(validateStudyPipeline(document)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          nodeId: "relax-1",
        }),
      ]),
    );
  });

  it("seeds new ground-state relax stages with the canonical torque default", () => {
    const document = createGroundStateTemplate();

    expect(document.nodes[0]).toMatchObject({
      node_kind: "primitive",
      stage_kind: "relax",
      payload: expect.objectContaining({
        torque_tolerance: "1e-4",
        max_steps: "5000",
      }),
    });
  });
});
