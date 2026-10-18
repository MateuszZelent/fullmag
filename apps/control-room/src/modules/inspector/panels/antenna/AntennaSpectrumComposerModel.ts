import type { SceneResource } from "@/kernel/api/apiTypes";
import { buildAntennaPlaneVector as vector3 } from "./AntennaSamplingPlaneFieldsModel";

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

export interface AntennaSpectrumLocalDraft {
  key: string;
  baseRevision: number;
  dirty: boolean;
  values: AntennaSpectrumDraft;
}

/** Keep later edits while advancing only the acknowledged draft's base. */
export function acknowledgeAntennaSpectrumDraft(
  current: AntennaSpectrumLocalDraft | null,
  submitted: AntennaSpectrumLocalDraft,
  revision: number,
): AntennaSpectrumLocalDraft | null {
  if (!current || current.key !== submitted.key) return current;
  return { ...current, baseRevision: revision, dirty: current !== submitted };
}

// Runtime contract: antenna_spectrum.rs::MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT.
export const MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT = 10_000_000;

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
  const stages = scene.antenna_field_solve_stages?.filter((item) => item.id === stageId) ?? [];
  const stage = stages.length === 1 ? stages[0] : null;
  if (!stage) throw new Error("Antenna field-solve stage is missing.");
  const sources = scene.objects?.filter((object) => object.id === stage.source_object_id) ?? [];
  if (sources.length !== 1 || sources[0].locked) throw new Error("Current unlocked source object is required.");
  if ((scene.current_transports ?? []).filter((transport) => transport.name === stage.current_transport_id).length !== 1) {
    throw new Error("Spectrum requires one existing current transport.");
  }
  const outputs = stage.outputs.filter((item) => item.quantity === "H_ant_basis");
  if (outputs.length !== 1 || !outputs[0].id.trim() || stage.outputs.filter((output) => output.id === outputs[0].id).length !== 1 || stage.port_mode_ids.length !== 1) {
    throw new Error("Spectrum requires one H_ant_basis output and one port mode.");
  }
  if ((scene.antenna_port_modes ?? []).filter((port) => port.id === stage.port_mode_ids[0]).length !== 1 || !scene.antenna_port_modes?.some((port) => port.id === stage.port_mode_ids[0] &&
    port.source_object_id === stage.source_object_id && port.current_transport_id === stage.current_transport_id)) {
    throw new Error("Spectrum port must belong to the selected solve stage.");
  }
  if (!draft.targetObjectId || (scene.objects ?? []).filter((object) => object.id === draft.targetObjectId).length !== 1) {
    throw new Error("Select an existing target object.");
  }
  if (!["rectangular", "hann", "hamming", "blackman"].includes(draft.windowKind)) throw new Error("Select a supported FFT window.");
  if (!["integral_si", "unitary_discrete"].includes(draft.normalization)) throw new Error("Select a supported FFT normalization.");
  if (!["x", "y", "z", "u", "v", "normal", "vector_power"].includes(draft.component)) throw new Error("Select a supported source FFT component; transverse requires a separate qualified equilibrium binding.");
  if (!["error", "zero"].includes(draft.outsidePolicy)) throw new Error("Select an explicit outside-domain policy.");
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
  if (countU * countV > MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT) throw new Error(`FFT grid exceeds the runtime limit of ${MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT} samples.`);
  const existing = new Set((scene.antenna_spectrum_requests ?? []).flatMap((item) => [item.id, item.output_id?.replace(/:output$/, "") ?? ""]));
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
