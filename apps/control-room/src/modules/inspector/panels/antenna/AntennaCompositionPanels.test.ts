import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";

import { resolveAntennaRuntimeIds } from "./AntennaCompositionPanels";

function sceneFixture(): SceneResource {
  return {
    antenna_field_solve_stages: [
      {
        id: "solve-1",
        outputs: [
          { id: "h-ant-output", quantity: "H_ant_basis" },
        ],
      },
    ],
    antenna_spectrum_requests: [
      {
        id: "spectrum-1",
        output_id: "spectrum-output",
        solution_ref: { output_id: "h-ant-output" },
      },
    ],
    antenna_target_projections: [
      {
        id: "projection-1",
        solution: { output_id: "h-ant-output" },
      },
    ],
    solved_antenna_drives: [
      { id: "drive-1", projection_ref: "projection-1" },
    ],
  } as unknown as SceneResource;
}

describe("resolveAntennaRuntimeIds", () => {
  it("resolves a solve-stage node to its published H_ant output", () => {
    expect(resolveAntennaRuntimeIds("solution", "solve-1", sceneFixture())).toEqual({
      solutionId: "h-ant-output",
      spectrumOutputId: null,
    });
  });

  it("resolves spectrum and drive nodes through their authored references", () => {
    const scene = sceneFixture();
    expect(resolveAntennaRuntimeIds("spectrum", "spectrum-1", scene)).toEqual({
      solutionId: "h-ant-output",
      spectrumOutputId: "spectrum-output",
    });
    expect(resolveAntennaRuntimeIds("drive", "drive-1", scene)).toEqual({
      solutionId: "h-ant-output",
      spectrumOutputId: null,
    });
  });

  it("fails closed when a published output is not present", () => {
    expect(resolveAntennaRuntimeIds("solution", "missing", sceneFixture())).toEqual({
      solutionId: null,
      spectrumOutputId: null,
    });
  });
});
