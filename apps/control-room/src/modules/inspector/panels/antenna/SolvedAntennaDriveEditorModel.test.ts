import { describe, expect, it } from "vitest";

import {
  antennaRunStageIds,
  buildSolvedDrive,
  changeSolvedDriveWaveformKind,
  solvedDriveDraft,
  type SolvedDrive,
} from "./SolvedAntennaDriveEditorModel";
import type { SceneResource } from "@/kernel/api/apiTypes";

const drive = {
  id: "drive-1",
  name: "RF",
  peak_current_a: 1,
  port_mode_id: "port-1",
  projection_ref: "projection-1",
  time_origin: "stage_local",
  waveform: { kind: "constant" },
  activation: { kind: "all_time_evolution" },
} as SolvedDrive;

describe("solved antenna drive editor model", () => {
  it("offers only authored Run stage IDs for activation", () => {
    const scene = { study: { stages: [
      { kind: "relax", stage_id: "relax-1" },
      { kind: "run", stage_id: "run-1" },
      { kind: "run", id: "run-2" },
      { kind: "run" },
    ] } } as SceneResource;
    expect(antennaRunStageIds(scene)).toEqual(["run-1", "run-2"]);
  });
  it("builds a sinusoid and selected stage activation without changing references", () => {
    const draft = changeSolvedDriveWaveformKind(solvedDriveDraft(drive), "sinusoidal");
    draft.frequencyHz = "2e9";
    draft.phaseRad = "0.5";
    draft.activationKind = "stage_ids";
    draft.stageIds = "run-1, run-2";
    expect(buildSolvedDrive(drive, draft)).toEqual({
      ...drive,
      waveform: { kind: "sinusoidal", frequency_hz: 2e9, phase_rad: 0.5, offset: 0 },
      activation: { kind: "stage_ids", stage_ids: ["run-1", "run-2"] },
      bandwidth_declaration: null,
    });
  });

  it("rejects invalid finite, activation, and piecewise inputs before committing", () => {
    const draft = solvedDriveDraft(drive);
    draft.peakCurrentA = "Infinity";
    expect(() => buildSolvedDrive(drive, draft)).toThrow("finite");
    draft.peakCurrentA = "1";
    draft.activationKind = "stage_ids";
    draft.stageIds = "run-1, run-1";
    expect(() => buildSolvedDrive(drive, draft)).toThrow("unique");
    draft.activationKind = "all_time_evolution";
    draft.waveformKind = "piecewise_linear";
    draft.piecewisePoints = "[[1,0],[0,1]]";
    expect(() => buildSolvedDrive(drive, draft)).toThrow("strictly increasing");
  });

  it("keeps an authored pulse band during same-kind edits and clears it on waveform change", () => {
    const pulse = {
      ...drive,
      waveform: { kind: "pulse" as const, t_on: 0, t_off: 1e-9 },
      bandwidth_declaration: { f_max_hz: 6e9 },
    };
    const draft = solvedDriveDraft(pulse);
    draft.peakCurrentA = "2";
    expect(buildSolvedDrive(pulse, draft).bandwidth_declaration).toEqual({ f_max_hz: 6e9 });
    draft.bandwidthHz = "-1";
    expect(() => buildSolvedDrive(pulse, draft)).toThrow("must be >= 0 Hz");
    const sinusoid = changeSolvedDriveWaveformKind(draft, "sinusoidal");
    expect(sinusoid.bandwidthHz).toBe("");
    expect(buildSolvedDrive(pulse, sinusoid).bandwidth_declaration).toBeNull();
  });
});
