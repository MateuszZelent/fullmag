import { describe, expect, it } from "vitest";

import { summarizeMaskFieldDriveStage } from "./maskFieldDriveStageSummary";

const drive = {
  schema_version: "mask_field_drive.v1",
  id: "antenna",
  name: "Antenna",
  target: { kind: "object", object_id: "sample" },
  shape: { kind: "box", size: [6e-6, 1e-6, 4.5e-8] },
  position_m: [0, 0, 0],
  frame: "world",
  time_origin: "absolute",
  terms: [
    {
      name: "source",
      mask: {
        kind: "function",
        function: {
          name: "antenna_mask",
          parameters: [
            { name: "B01", value: 0.0002 },
            { name: "wavelength", value: 2.79e-7 },
          ],
          outputs: ["B01 * g * sin(k * x - pi / 2)", "0.0", "B01 * g * sin(k * x)"],
        },
      },
      time: {
        name: "antenna_time",
        parameters: [{ name: "frequency", value: 3.6e9 }],
        outputs: ["sin(2 * pi * frequency * t)"],
      },
    },
    { mask: { kind: "sampled", size: [1200, 200, 15] } },
  ],
};

describe("summarizeMaskFieldDriveStage", () => {
  it("summarizes an Add stage from a flat stage and from a pipeline node", () => {
    const flat = summarizeMaskFieldDriveStage({ kind: "add_mask_field_drive", drive });
    const node = summarizeMaskFieldDriveStage({
      id: "add_antenna",
      payload: { kind: "add_mask_field_drive", stage_id: "add_antenna", drive },
    });

    expect(node).toEqual(flat);
    expect(flat).toMatchObject({
      action: "add",
      driveId: "antenna",
      driveName: "Antenna",
      frame: "world",
      kindLabel: "Add Antenna",
      shape: "box 0.000006 x 0.000001 x 4.5e-8 m",
      target: "object sample",
      timeOrigin: "absolute",
    });
    expect(flat?.terms).toEqual([
      {
        label: "source",
        mask: {
          call: "antenna_mask(B01 = 0.0002, wavelength = 2.79e-7)",
          outputs: ["B01 * g * sin(k * x - pi / 2)", "0.0", "B01 * g * sin(k * x)"],
        },
        time: {
          call: "antenna_time(frequency = 3600000000)",
          outputs: ["sin(2 * pi * frequency * t)"],
        },
      },
      {
        label: "term 1",
        mask: { call: "array 1200 x 200 x 15", outputs: [] },
        time: { call: "1 (static)", outputs: [] },
      },
    ]);
  });

  it("summarizes an Update stage with its parameter values", () => {
    expect(
      summarizeMaskFieldDriveStage({
        kind: "update_mask_field_drive",
        drive_id: "antenna",
        term: "source",
        mask_parameters: { B01: 0.0004 },
        time_parameters: {},
      }),
    ).toMatchObject({
      action: "update",
      driveId: "antenna",
      kindLabel: "Update Antenna",
      maskParameters: "B01 = 0.0004",
      term: "source",
      timeParameters: null,
    });
  });

  it("selects the only term when an Update names none", () => {
    expect(
      summarizeMaskFieldDriveStage({
        kind: "update_mask_field_drive",
        drive_id: "antenna",
        term: null,
        time_parameters: { frequency: 4.5e9 },
      }),
    ).toMatchObject({ maskParameters: null, term: null, timeParameters: "frequency = 4500000000" });
  });

  it("returns null for other stages and malformed payloads", () => {
    expect(summarizeMaskFieldDriveStage({ kind: "remove_field_drive", drive_id: "antenna" })).toBeNull();
    expect(summarizeMaskFieldDriveStage({ kind: "add_mask_field_drive" })).toBeNull();
    expect(summarizeMaskFieldDriveStage({ kind: "future_solver_action" })).toBeNull();
    expect(summarizeMaskFieldDriveStage(null)).toBeNull();
    expect(summarizeMaskFieldDriveStage("add_mask_field_drive")).toBeNull();
  });
});
