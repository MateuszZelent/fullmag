import type { AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

export type SolvedDrive = NonNullable<SceneResource["solved_antenna_drives"]>[number];
export type WaveformKind = SolvedDrive["waveform"]["kind"];

export interface SolvedDriveDraft {
  name: string;
  projectionRef: string;
  portModeId: string;
  peakCurrentA: string;
  timeOrigin: SolvedDrive["time_origin"];
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

export interface SolvedDriveLocalDraft {
  id: string;
  draft: SolvedDriveDraft;
  dirtyKeys: Array<keyof SolvedDriveDraft>;
  editedAgainst: Partial<SolvedDriveDraft>;
  acknowledgedBase?: { revision: number; draft: SolvedDriveDraft };
}

/** Preserve edits made after submission and rebase them onto acknowledged values. */
export function acknowledgeSolvedDriveDraft(
  current: SolvedDriveLocalDraft | null, driveId: string,
  submitted: SolvedDriveDraft, acknowledged: SolvedDriveDraft, revision?: number,
): SolvedDriveLocalDraft | null {
  if (!current || current.id !== driveId) return current;
  const dirtyKeys = current.dirtyKeys.filter((key) =>
    current.draft[key] !== submitted[key] && current.draft[key] !== acknowledged[key]);
  if (!dirtyKeys.length && revision === undefined) return null;
  return {
    ...current,
    draft: { ...acknowledged, ...Object.fromEntries(dirtyKeys.map((key) => [key, current.draft[key]])) },
    dirtyKeys,
    editedAgainst: Object.fromEntries(dirtyKeys.map((key) => [key, acknowledged[key]])),
    ...(revision === undefined ? {} : { acknowledgedBase: { revision, draft: acknowledged } }),
  };
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

export function antennaRunStageOptions(scene: SceneResource | null): Array<{ id: string; label: string }> {
  const source = readStudyStageSource(scene?.study);
  if (source.kind === "invalid") return [];
  const options = source.entries.flatMap((entry, index) => {
    if (!entry.enabled) return [];
    const stage = entry.payload;
    const id = source.kind === "pipeline"
      ? entry.stageKind === "run" ? entry.queueId : null
      : stage.kind === "run" ? typeof stage.stage_id === "string" ? stage.stage_id : stage.id : null;
    if (typeof id !== "string" || !id.trim()) return [];
    const name = entry.label ?? stage.name ?? stage.label;
    return [{ id, label: typeof name === "string" && name.trim() ? name.trim() : `Run ${index + 1}` }];
  });
  return options.filter(option => options.filter(item => item.id === option.id).length === 1).map(option => ({ ...option, label: options.filter(item => item.label === option.label).length > 1 ? `${option.label} [${option.id}]` : option.label }));
}

export function antennaRunStageIds(scene: SceneResource | null): string[] {
  return antennaRunStageOptions(scene).map(option => option.id);
}

export function solvedDriveDraft(drive: SolvedDrive): SolvedDriveDraft {
  const waveform = drive.waveform;
  return {
    name: drive.name,
    projectionRef: drive.projection_ref,
    portModeId: drive.port_mode_id,
    peakCurrentA: String(drive.peak_current_a),
    timeOrigin: drive.time_origin,
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
  const trimmedName = draft.name.trim();
  if (!trimmedName) throw new Error("Drive name is required");
  const name = draft.name === existing.name ? existing.name : trimmedName;
  const peakCurrent = finiteNumber(draft.peakCurrentA, "Peak current");
  if (draft.timeOrigin !== "stage_local" && draft.timeOrigin !== "absolute") throw new Error("Select a supported time origin");
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
      waveform = { kind: "piecewise_linear", points: buildPiecewiseDrivePoints(draft.piecewisePoints) };
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
    name,
    projection_ref: draft.projectionRef,
    port_mode_id: draft.portModeId,
    peak_current_a: peakCurrent,
    time_origin: draft.timeOrigin,
    waveform,
    activation,
    bandwidth_declaration: bandwidthDeclaration,
  };
}

export function resolveCommittedSolvedDriveScene(
  result: AuthoringTransactionResponse, expectedDrive: SolvedDrive, expectedSceneId: string, baseRevision: number,
): SceneResource {
  const committed = result.committed_scene;
  const matches = committed?.solved_antenna_drives?.filter((item) => item.id === expectedDrive.id) ?? [];
  if (!expectedSceneId.trim() || !committed || committed.scene?.id !== expectedSceneId || committed.revision !== result.scene_revision ||
    !Number.isSafeInteger(result.scene_revision) || result.scene_revision <= baseRevision || matches.length !== 1) {
    throw new Error("Drive ACK did not provide the current committed scene. Refresh before saving again.");
  }
  for (const key of ["projection_ref", "port_mode_id"] as const) {
    if (matches[0][key] !== expectedDrive[key]) throw new Error("Drive ACK changed the submitted binding. Refresh before saving again.");
  }
  const expected = solvedDriveDraft(expectedDrive);
  const actual = solvedDriveDraft(matches[0]);
  if ((Object.keys(expected) as Array<keyof SolvedDriveDraft>).some((field) => expected[field] !== actual[field])) {
    throw new Error("Drive ACK changed the submitted parameters. Refresh before saving again.");
  }
  return committed;
}

/** Local Save and the workspace transition guard share the same conflict decision. */
export function solvedDriveSaveBlockReason(validationError: string | null, localConflictCount: number, conflictPhase: string | null | undefined): string | undefined {
  if (validationError) return validationError;
  if (localConflictCount > 0 || conflictPhase && conflictPhase !== "rebased") return "Review and rebase the conflicting drive draft.";
  return undefined;
}

export type PiecewiseDrivePointDraft = [string, string];

/** Text belongs to the local draft; the canonical waveform always contains numbers. */
export function readPiecewiseDrivePoints(value: string): PiecewiseDrivePointDraft[] {
  let points: unknown;
  try { points = JSON.parse(value); } catch { throw new Error("The point draft is malformed. Reset the drive to restore its committed points."); }
  if (!Array.isArray(points) || points.some(point => !Array.isArray(point) || point.length !== 2 || point.some(cell => typeof cell !== "string" && typeof cell !== "number"))) {
    throw new Error("The point draft must contain time/multiplier pairs. Reset the drive to restore its committed points.");
  }
  return points.map(point => [String(point[0]), String(point[1])]);
}

export function piecewiseDrivePointErrors(points: readonly PiecewiseDrivePointDraft[]): Array<[string | undefined, string | undefined]> {
  return points.map((point, index) => {
    const errors: [string | undefined, string | undefined] = [undefined, undefined];
    for (const column of [0, 1] as const) {
      try { finiteNumber(point[column], column === 0 ? "Time" : "Multiplier"); }
      catch (error) { errors[column] = error instanceof Error ? error.message : String(error); }
    }
    if (!errors[0] && index > 0 && points[index - 1][0].trim() && Number.isFinite(Number(points[index - 1][0])) && Number(point[0]) <= Number(points[index - 1][0])) {
      errors[0] = "Times must be strictly increasing.";
    }
    return errors;
  });
}

export function buildPiecewiseDrivePoints(value: string): number[][] {
  const points = readPiecewiseDrivePoints(value);
  if (points.length < 2) throw new Error("At least two waveform points are required.");
  const errors = piecewiseDrivePointErrors(points);
  for (let index = 0; index < errors.length; index++) {
    const error = errors[index][0] ?? errors[index][1];
    if (error) throw new Error(`Point ${index + 1}: ${error}`);
  }
  return points.map(([time, multiplier]) => [Number(time), Number(multiplier)]);
}

/** Keep the acknowledged draft base until the scene hook observes that revision. */
export function resolvedSolvedDriveDraftBase(server: SolvedDriveDraft | null, local: SolvedDriveLocalDraft | null, revision: number | null | undefined): SolvedDriveDraft | null {
  return local?.acknowledgedBase && (revision == null || revision < local.acknowledgedBase.revision)
    ? local.acknowledgedBase.draft : server;
}
