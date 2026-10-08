import type { SceneResource } from "@/kernel/api/apiTypes";

import { antennaRunStageIds } from "./SolvedAntennaDriveEditorModel";

function nextId(prefix: string, existing: string[]): string {
  const taken = new Set(existing);
  let index = 1;
  while (taken.has(`${prefix}:${index}`)) index += 1;
  return `${prefix}:${index}`;
}

export function composeAntennaProjectionDrive(
  scene: SceneResource,
  stageId: string,
  targetObjectId: string,
  runStageId: string,
  peakCurrentText: string,
  frequencyText: string,
) {
  const stage = scene.antenna_field_solve_stages?.find((item) => item.id === stageId);
  if (!stage) throw new Error("Antenna field-solve stage is missing.");
  const output = stage.outputs.filter((item) => item.quantity === "H_ant_basis");
  if (output.length !== 1) throw new Error("Field-solve stage must publish exactly one H_ant_basis output.");
  if (stage.port_mode_ids.length !== 1 || !scene.antenna_port_modes?.some((port) =>
    port.id === stage.port_mode_ids[0] && port.source_object_id === stage.source_object_id &&
    port.current_transport_id === stage.current_transport_id)) {
    throw new Error("Field-solve stage requires one matching antenna port.");
  }
  if (!targetObjectId || targetObjectId === stage.source_object_id ||
      !scene.objects?.some((object) => object.id === targetObjectId)) {
    throw new Error("Select an existing target object other than the conductor.");
  }
  if (!antennaRunStageIds(scene).includes(runStageId)) {
    throw new Error("Select an authored Run stage for activation.");
  }
  const peakCurrentA = Number(peakCurrentText);
  const frequencyHz = Number(frequencyText);
  if (!peakCurrentText.trim() || !Number.isFinite(peakCurrentA)) {
    throw new Error("Peak current must be a finite value in A.");
  }
  if (!frequencyText.trim() || !Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    throw new Error("Frequency must be finite and > 0 Hz.");
  }
  const projectionId = nextId(`${stage.id}:projection`, scene.antenna_target_projections?.map((item) => item.id) ?? []);
  const driveId = nextId(`${stage.id}:drive`, scene.solved_antenna_drives?.map((item) => item.id) ?? []);
  return {
    projection: {
      id: projectionId,
      solution: { kind: "stage_output" as const, stage_id: stage.id, output_id: output[0].id },
      target: { kind: "object" as const, object_id: targetObjectId },
      output_id: `${projectionId}:field`,
    },
    drive: {
      id: driveId,
      name: `Antenna drive ${driveId}`,
      projection_ref: projectionId,
      port_mode_id: stage.port_mode_ids[0],
      peak_current_a: peakCurrentA,
      waveform: { kind: "sinusoidal" as const, frequency_hz: frequencyHz, phase_rad: 0, offset: 0 },
      time_origin: "stage_local" as const,
      activation: { kind: "stage_ids" as const, stage_ids: [runStageId] },
    },
  };
}
