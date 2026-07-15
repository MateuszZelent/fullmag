import { describe, expect, it } from "vitest";

import type { RegionalFieldDriveResource } from "../../../kernel/api/apiTypes";
import {
  evaluateDriveWaveform,
  milliTeslaToTesla,
  teslaToMilliTesla,
  validateFieldDriveDraft,
} from "./fieldDrive";

function sincDrive(): RegionalFieldDriveResource {
  return {
    id: "drive-sinc",
    name: "Sinc pulse",
    kind: "regional",
    enabled: true,
    target: { kind: "global" },
    amplitude_B_T: 1e-3,
    direction: [0, 1, 0],
    spatial_profile: { kind: "uniform" },
    waveform: {
      kind: "sinc_pulse",
      cutoff_hz: 20e9,
      t0: 50e-12,
      amplitude: 1,
    },
    time_origin: "stage_local",
    activation: { kind: "stage_ids", stage_ids: ["run"] },
  };
}

describe("regional field drive domain model", () => {
  it("converts mT and T exactly within floating point precision", () => {
    expect(teslaToMilliTesla(milliTeslaToTesla(2.5))).toBeCloseTo(2.5, 14);
  });

  it("uses a stable normalized sinc at its center", () => {
    expect(evaluateDriveWaveform(sincDrive(), 50e-12)).toBe(1);
  });

  it("rejects an empty stage selection", () => {
    const drive = sincDrive();
    drive.activation = { kind: "stage_ids", stage_ids: [] };
    expect(validateFieldDriveDraft(drive)).toContain(
      "Select at least one run stage.",
    );
  });

  it("rejects incomplete targets and spatial profiles", () => {
    const drive = sincDrive();
    drive.target = { kind: "region", object_id: "", region_id: "" };
    drive.spatial_profile = { kind: "sinc", axis: [0, 0, 0], period_m: 0 };
    expect(validateFieldDriveDraft(drive)).toEqual(expect.arrayContaining([
      "Target object id is required.",
      "Target stable region id is required.",
      "Spatial sinc axis must be non-zero.",
      "Spatial sinc period must be finite and positive.",
    ]));
  });

  it("rejects invalid waveform parameters and unordered PWL points", () => {
    const drive = sincDrive();
    drive.waveform = { kind: "piecewise_linear", points: [[1, 0], [0, 1]] };
    expect(validateFieldDriveDraft(drive)).toContain(
      "Piecewise-linear times must be finite and strictly increasing.",
    );
    drive.waveform = { kind: "pulse", t_on: 2, t_off: 1 };
    expect(validateFieldDriveDraft(drive)).toContain(
      "Pulse off time must be greater than on time.",
    );
  });
});
