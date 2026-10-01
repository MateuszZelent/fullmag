import type { SceneResource } from "@/kernel/api/apiTypes";

export type SolvedDrive = NonNullable<SceneResource["solved_antenna_drives"]>[number];
export type WaveformKind = SolvedDrive["waveform"]["kind"];

export interface SolvedDriveDraft {
  peakCurrentA: string;
  waveformKind: WaveformKind;
  frequencyHz: string;
  phaseRad: string;
  offset: string;
  cutoffHz: string;
  sincT0: string;
  sincAmplitude: string;
  pulseOn: string;
  pulseOff: string;
  piecewisePoints: string;
  bandwidthHz: string;
  activationKind: SolvedDrive["activation"]["kind"];
  stageIds: string;
}

export const waveformDefaults = {
  frequencyHz: "1000000000",
  phaseRad: "0",
  offset: "0",
  cutoffHz: "20000000000",
  sincT0: "5e-11",
  sincAmplitude: "1",
  pulseOn: "0",
  pulseOff: "1e-9",
  piecewisePoints: "[[0,0],[1e-9,1]]",
};

export function antennaRunStageIds(scene: SceneResource | null): string[] {
  const stages = scene?.study && Array.isArray(scene.study.stages) ? scene.study.stages : [];
  return stages.flatMap((stage) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage) || stage.kind !== "run") return [];
    const id = typeof stage.stage_id === "string" ? stage.stage_id : stage.id;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}

export function solvedDriveDraft(drive: SolvedDrive): SolvedDriveDraft {
  const waveform = drive.waveform;
  return {
    peakCurrentA: String(drive.peak_current_a),
    waveformKind: waveform.kind,
    frequencyHz: waveform.kind === "sinusoidal" ? String(waveform.frequency_hz) : waveformDefaults.frequencyHz,
    phaseRad: waveform.kind === "sinusoidal" ? String(waveform.phase_rad ?? 0) : waveformDefaults.phaseRad,
    offset: waveform.kind === "sinusoidal" ? String(waveform.offset ?? 0) : waveformDefaults.offset,
    cutoffHz: waveform.kind === "sinc_pulse" ? String(waveform.cutoff_hz) : waveformDefaults.cutoffHz,
    sincT0: waveform.kind === "sinc_pulse" ? String(waveform.t0 ?? 0) : waveformDefaults.sincT0,
    sincAmplitude: waveform.kind === "sinc_pulse" ? String(waveform.amplitude ?? 1) : waveformDefaults.sincAmplitude,
    pulseOn: waveform.kind === "pulse" ? String(waveform.t_on) : waveformDefaults.pulseOn,
    pulseOff: waveform.kind === "pulse" ? String(waveform.t_off) : waveformDefaults.pulseOff,
    piecewisePoints: waveform.kind === "piecewise_linear" ? JSON.stringify(waveform.points) : waveformDefaults.piecewisePoints,
    bandwidthHz: drive.bandwidth_declaration ? String(drive.bandwidth_declaration.f_max_hz) : "",
    activationKind: drive.activation.kind,
    stageIds: drive.activation.kind === "stage_ids" ? drive.activation.stage_ids.join(", ") : "",
  };
}

export function changeSolvedDriveWaveformKind(
  draft: SolvedDriveDraft,
  waveformKind: WaveformKind,
): SolvedDriveDraft {
  if (waveformKind === draft.waveformKind) return draft;
  return { ...draft, ...waveformDefaults, waveformKind, bandwidthHz: "" };
}

function finiteNumber(value: string, label: string): number {
  if (!value.trim()) throw new Error(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

export function buildSolvedDrive(
  existing: SolvedDrive,
  draft: SolvedDriveDraft,
): SolvedDrive {
  const peakCurrent = finiteNumber(draft.peakCurrentA, "Peak current");
  let waveform: SolvedDrive["waveform"];
  switch (draft.waveformKind) {
    case "constant":
      waveform = { kind: "constant" };
      break;
    case "sinusoidal": {
      const frequency = finiteNumber(draft.frequencyHz, "Frequency");
      if (frequency <= 0) throw new Error("Frequency must be > 0 Hz");
      waveform = {
        kind: "sinusoidal",
        frequency_hz: frequency,
        phase_rad: finiteNumber(draft.phaseRad, "Phase"),
        offset: finiteNumber(draft.offset, "Offset"),
      };
      break;
    }
    case "sinc_pulse": {
      const cutoff = finiteNumber(draft.cutoffHz, "Sinc cutoff");
      const t0 = finiteNumber(draft.sincT0, "Sinc t0");
      if (cutoff <= 0 || t0 < 0) throw new Error("Sinc requires cutoff > 0 Hz and t0 >= 0 s");
      waveform = {
        kind: "sinc_pulse",
        cutoff_hz: cutoff,
        t0,
        amplitude: finiteNumber(draft.sincAmplitude, "Sinc amplitude"),
      };
      break;
    }
    case "pulse": {
      const tOn = finiteNumber(draft.pulseOn, "Pulse t_on");
      const tOff = finiteNumber(draft.pulseOff, "Pulse t_off");
      if (tOff <= tOn) throw new Error("Pulse requires t_off > t_on");
      waveform = { kind: "pulse", t_on: tOn, t_off: tOff };
      break;
    }
    case "piecewise_linear": {
      let points: unknown;
      try {
        points = JSON.parse(draft.piecewisePoints);
      } catch {
        throw new Error("Piecewise points must be valid JSON pairs");
      }
      if (
        !Array.isArray(points) || points.length < 2 ||
        points.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((value) => typeof value !== "number" || !Number.isFinite(value))) ||
        points.some((point, index) => index > 0 && point[0] <= points[index - 1][0])
      ) {
        throw new Error("Piecewise points require finite pairs and strictly increasing times");
      }
      waveform = { kind: "piecewise_linear", points: points as number[][] };
      break;
    }
  }
  const stageIds = draft.stageIds.split(",").map((id) => id.trim());
  if (draft.activationKind === "stage_ids" &&
      (stageIds.some((id) => !id) || new Set(stageIds).size !== stageIds.length)) {
    throw new Error("Activation stage ids must be non-empty and unique");
  }
  const activation: SolvedDrive["activation"] = draft.activationKind === "stage_ids"
    ? { kind: "stage_ids", stage_ids: stageIds }
    : { kind: "all_time_evolution" };
  const bandwidthDeclaration = waveform.kind === "pulse" || waveform.kind === "piecewise_linear"
    ? draft.bandwidthHz.trim()
      ? { f_max_hz: finiteNumber(draft.bandwidthHz, "Declared bandwidth") }
      : null
    : null;
  if (bandwidthDeclaration && bandwidthDeclaration.f_max_hz < 0) {
    throw new Error("Declared bandwidth must be >= 0 Hz");
  }
  return {
    ...existing,
    peak_current_a: peakCurrent,
    waveform,
    activation,
    bandwidth_declaration: bandwidthDeclaration,
  };
}
