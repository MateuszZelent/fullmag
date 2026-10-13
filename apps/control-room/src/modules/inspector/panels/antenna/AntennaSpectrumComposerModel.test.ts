import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";

import {
  composeAntennaSpectrumRequest,
  emptyAntennaSpectrumDraft,
} from "./AntennaSpectrumComposerModel";

const scene = {
  objects: [{ id: "magnet" }],
  antenna_field_solve_stages: [{
    id: "solve", source_object_id: "conductor", current_transport_id: "current",
    port_mode_ids: ["port"], outputs: [{ id: "basis", quantity: "H_ant_basis" }],
  }],
  antenna_port_modes: [{ id: "port", source_object_id: "conductor", current_transport_id: "current" }],
  antenna_spectrum_requests: [],
} as unknown as SceneResource;

const validDraft = {
  ...emptyAntennaSpectrumDraft,
  targetObjectId: "magnet",
  originM: "0, 0, 0",
  axisU: "1, 0, 0",
  axisV: "0, 1, 0",
  extentUM: "2e-7",
  extentVM: "1e-7",
  samplesU: "33",
  samplesV: "17",
};

describe("composeAntennaSpectrumRequest", () => {
  it("authors a structured source FFT with symbolic field output and SI sampling plane", () => {
    expect(composeAntennaSpectrumRequest(scene, "solve", validDraft)).toEqual({
      id: "solve:spectrum:1",
      solution_ref: { kind: "stage_output", stage_id: "solve", output_id: "basis" },
      port_mode_id: "port",
      target: { kind: "object", object_id: "magnet" },
      transform: "spatial_fft",
      sampling_plane: {
        origin_m: [0, 0, 0], axis_u: [1, 0, 0], axis_v: [0, 1, 0],
        extent_u_m: 2e-7, extent_v_m: 1e-7,
        sample_count_u: 33, sample_count_v: 17,
        interpolation: "fem_element", outside_policy: "error",
      },
      window: "rectangular", normalization: "integral_si", component: "x",
      output_id: "solve:spectrum:1:output",
    });
  });

  it("rejects non-orthonormal axes, undersampled windows and nonexistent targets", () => {
    expect(() => composeAntennaSpectrumRequest(scene, "solve", { ...validDraft, axisV: "1, 0, 0" })).toThrow("orthonormal");
    expect(() => composeAntennaSpectrumRequest(scene, "solve", { ...validDraft, windowKind: "hann", samplesU: "2" })).toThrow("Samples u");
    expect(() => composeAntennaSpectrumRequest(scene, "solve", { ...validDraft, targetObjectId: "missing" })).toThrow("target object");
  });

  it("keeps the FFT request distinct from drive current and allocates a fresh output", () => {
    const withRequest = { ...scene, antenna_spectrum_requests: [{ id: "solve:spectrum:1" }] } as SceneResource;
    const request = composeAntennaSpectrumRequest(withRequest, "solve", validDraft);
    expect(request.id).toBe("solve:spectrum:2");
    expect(request.output_id).toBe("solve:spectrum:2:output");
    expect(request).not.toHaveProperty("peak_current_a");
  });
});
