import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";

import { composeAntennaProjectionDrive } from "./AntennaProjectionDriveComposerModel";

const scene = {
  objects: [{ id: "conductor", name: "Conductor" }, { id: "magnet", name: "Magnet" }],
  study: { stages: [{ kind: "relax", stage_id: "relax" }, { kind: "run", stage_id: "run" }] },
  antenna_field_solve_stages: [{
    id: "solve", source_object_id: "conductor", current_transport_id: "current",
    port_mode_ids: ["port"], outputs: [{ id: "basis", quantity: "H_ant_basis" }],
  }],
  antenna_port_modes: [{ id: "port", source_object_id: "conductor", current_transport_id: "current" }],
  antenna_target_projections: [],
  solved_antenna_drives: [],
} as unknown as SceneResource;

describe("composeAntennaProjectionDrive", () => {
  it("creates an atomic symbolic projection and stage-scoped sinusoidal drive", () => {
    const { projection, drive } = composeAntennaProjectionDrive(scene, "solve", "magnet", "run", "0.01", "1e9");
    expect(projection).toEqual({
      id: "solve:projection:1",
      solution: { kind: "stage_output", stage_id: "solve", output_id: "basis" },
      target: { kind: "object", object_id: "magnet" },
      output_id: "solve:projection:1:field",
    });
    expect(drive).toEqual(expect.objectContaining({
      id: "solve:drive:1", projection_ref: projection.id, port_mode_id: "port",
      peak_current_a: 0.01,
      waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0, offset: 0 },
      activation: { kind: "stage_ids", stage_ids: ["run"] },
    }));
  });

  it("rejects conductor target, Relax activation, and invalid current", () => {
    expect(() => composeAntennaProjectionDrive(scene, "solve", "conductor", "run", "0.01", "1e9")).toThrow("target object");
    expect(() => composeAntennaProjectionDrive(scene, "solve", "magnet", "relax", "0.01", "1e9")).toThrow("Run stage");
    expect(() => composeAntennaProjectionDrive(scene, "solve", "magnet", "run", "Infinity", "1e9")).toThrow("finite");
  });

  it("allocates IDs without overwriting existing projection or drive", () => {
    const existing = {
      ...scene,
      antenna_target_projections: [{ id: "solve:projection:1" }],
      solved_antenna_drives: [{ id: "solve:drive:1" }],
    } as SceneResource;
    const created = composeAntennaProjectionDrive(existing, "solve", "magnet", "run", "0.01", "1e9");
    expect(created.projection.id).toBe("solve:projection:2");
    expect(created.drive.id).toBe("solve:drive:2");
  });
});
