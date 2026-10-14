import type { SceneResource } from "@/kernel/api/apiTypes";

export interface AntennaSpectrumDraft {
  targetObjectId: string;
  originM: string;
  axisU: string;
  axisV: string;
  extentUM: string;
  extentVM: string;
  samplesU: string;
  samplesV: string;
  windowKind: "rectangular" | "hann" | "hamming" | "blackman";
  normalization: "integral_si" | "unitary_discrete";
  component: "x" | "y" | "z" | "u" | "v" | "normal" | "vector_power";
  outsidePolicy: "error" | "zero";
}

export const emptyAntennaSpectrumDraft: AntennaSpectrumDraft = {
  targetObjectId: "",
  originM: "",
  axisU: "",
  axisV: "",
  extentUM: "",
  extentVM: "",
  samplesU: "",
  samplesV: "",
  windowKind: "rectangular",
  normalization: "integral_si",
  component: "x",
  outsidePolicy: "error",
};

function vector3(text: string, label: string): [number, number, number] {
  const values = text.split(/[ ,;]+/).filter(Boolean).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} requires three finite values.`);
  }
  return values as [number, number, number];
}

function finitePositive(text: string, label: string): number {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite and > 0.`);
  }
  return value;
}

function sampleCount(text: string, label: string, minimum: number): number {
  const value = Number(text);
  if (!text.trim() || !Number.isSafeInteger(value) || value < minimum || value > 4294967295) {
    throw new Error(`${label} must be an integer between ${minimum} and 4294967295.`);
  }
  return value;
}

export function composeAntennaSpectrumRequest(
  scene: SceneResource,
  stageId: string,
  draft: AntennaSpectrumDraft,
) {
  const stage = scene.antenna_field_solve_stages?.find((item) => item.id === stageId);
  if (!stage) throw new Error("Antenna field-solve stage is missing.");
  const outputs = stage.outputs.filter((item) => item.quantity === "H_ant_basis");
  if (outputs.length !== 1 || stage.port_mode_ids.length !== 1) {
    throw new Error("Spectrum requires one H_ant_basis output and one port mode.");
  }
  if (!scene.antenna_port_modes?.some((port) => port.id === stage.port_mode_ids[0] &&
    port.source_object_id === stage.source_object_id && port.current_transport_id === stage.current_transport_id)) {
    throw new Error("Spectrum port must belong to the selected solve stage.");
  }
  if (!draft.targetObjectId || !scene.objects?.some((object) => object.id === draft.targetObjectId)) {
    throw new Error("Select an existing target object.");
  }
  const origin = vector3(draft.originM, "Plane origin [m]");
  const axisU = vector3(draft.axisU, "Axis u");
  const axisV = vector3(draft.axisV, "Axis v");
  const norm = (axis: number[]) => axis.reduce((sum, value) => sum + value * value, 0);
  const dot = axisU.reduce((sum, value, index) => sum + value * axisV[index], 0);
  if (Math.abs(norm(axisU) - 1) > 1e-12 || Math.abs(norm(axisV) - 1) > 1e-12 || Math.abs(dot) > 1e-12) {
    throw new Error("Sampling axes must be orthonormal unit vectors.");
  }
  const extentU = finitePositive(draft.extentUM, "Extent u [m]");
  const extentV = finitePositive(draft.extentVM, "Extent v [m]");
  const minimum = draft.windowKind === "rectangular" ? 2 : 3;
  const countU = sampleCount(draft.samplesU, "Samples u", minimum);
  const countV = sampleCount(draft.samplesV, "Samples v", minimum);
  if (!Number.isSafeInteger(countU * countV)) throw new Error("Sample grid product exceeds safe integer range.");
  const existing = new Set(scene.antenna_spectrum_requests?.map((item) => item.id) ?? []);
  let index = 1;
  while (existing.has(`${stage.id}:spectrum:${index}`)) index += 1;
  const id = `${stage.id}:spectrum:${index}`;
  return {
    id,
    solution_ref: { kind: "stage_output" as const, stage_id: stage.id, output_id: outputs[0].id },
    port_mode_id: stage.port_mode_ids[0],
    target: { kind: "object" as const, object_id: draft.targetObjectId },
    transform: "spatial_fft" as const,
    sampling_plane: {
      origin_m: origin,
      axis_u: axisU,
      axis_v: axisV,
      extent_u_m: extentU,
      extent_v_m: extentV,
      sample_count_u: countU,
      sample_count_v: countV,
      interpolation: "fem_element",
      outside_policy: draft.outsidePolicy,
    },
    window: draft.windowKind,
    normalization: draft.normalization,
    component: draft.component,
    output_id: `${id}:output`,
  };
}
