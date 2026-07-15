import type { RegionalFieldDriveResource } from "../../../kernel/api/apiTypes";

const MU_0 = 4e-7 * Math.PI;

export function teslaToMilliTesla(valueT: number): number {
  return valueT * 1e3;
}

export function milliTeslaToTesla(valueMilliT: number): number {
  return valueMilliT * 1e-3;
}

export function driveAmplitudeApm(drive: RegionalFieldDriveResource): number {
  return drive.amplitude_B_T / MU_0;
}

export function evaluateDriveWaveform(
  drive: RegionalFieldDriveResource,
  timeS: number,
): number {
  const waveform = drive.waveform;
  switch (waveform.kind) {
    case "constant":
      return 1;
    case "sinusoidal":
      return (
        Math.sin(
          2 * Math.PI * waveform.frequency_hz * timeS + (waveform.phase_rad ?? 0),
        ) + (waveform.offset ?? 0)
      );
    case "pulse":
      return timeS >= waveform.t_on && timeS < waveform.t_off ? 1 : 0;
    case "piecewise_linear":
      return evaluatePiecewiseLinear(waveform.points, timeS);
    case "sinc_pulse": {
      const x = 2 * waveform.cutoff_hz * (timeS - (waveform.t0 ?? 0));
      return (waveform.amplitude ?? 1) * normalizedSinc(x);
    }
  }
}

export function validateFieldDriveDraft(
  drive: RegionalFieldDriveResource,
): string[] {
  const errors: string[] = [];
  if (drive.id.trim().length === 0) errors.push("Drive id is required.");
  if (drive.name.trim().length === 0) errors.push("Drive name is required.");
  if (!Number.isFinite(drive.amplitude_B_T) || drive.amplitude_B_T < 0) {
    errors.push("Amplitude must be finite and non-negative.");
  }
  const norm = Math.hypot(...drive.direction);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-9) {
    errors.push("Direction must be a normalized vector.");
  }
  if (
    drive.activation.kind === "stage_ids" &&
    drive.activation.stage_ids.length === 0
  ) {
    errors.push("Select at least one run stage.");
  }
  if (
    drive.waveform.kind === "sinc_pulse" &&
    (!Number.isFinite(drive.waveform.cutoff_hz) ||
      drive.waveform.cutoff_hz <= 0)
  ) {
    errors.push("Sinc cutoff must be finite and positive.");
  }
  if (drive.target.kind !== "global" && drive.target.object_id.trim().length === 0) {
    errors.push("Target object id is required.");
  }
  if (drive.target.kind === "region" && drive.target.region_id.trim().length === 0) {
    errors.push("Target stable region id is required.");
  }
  validateSpatialProfile(drive.spatial_profile, errors);
  if (drive.waveform.kind === "sinusoidal" && (!Number.isFinite(drive.waveform.frequency_hz) || drive.waveform.frequency_hz <= 0)) {
    errors.push("Sinusoidal frequency must be finite and positive.");
  }
  if (drive.waveform.kind === "pulse" && (!Number.isFinite(drive.waveform.t_on) || !Number.isFinite(drive.waveform.t_off) || drive.waveform.t_off <= drive.waveform.t_on)) {
    errors.push("Pulse off time must be greater than on time.");
  }
  if (drive.waveform.kind === "piecewise_linear") {
    const points = drive.waveform.points;
    const ordered = points.length >= 2 && points.every((point, index) => point.length === 2 && point.every(Number.isFinite) && (index === 0 || point[0] > points[index - 1][0]));
    if (!ordered) errors.push("Piecewise-linear times must be finite and strictly increasing.");
  }
  return errors;
}

function validateSpatialProfile(
  profile: RegionalFieldDriveResource["spatial_profile"],
  errors: string[],
): void {
  if (profile.kind === "geometry_mask") {
    if (profile.object_id.trim().length === 0) errors.push("Mask geometry id is required.");
    if (profile.envelope.kind === "sinc") validateSincProfile(profile.envelope, errors);
  } else if (profile.kind === "sinc") {
    validateSincProfile(profile, errors);
  }
}

function validateSincProfile(
  profile: Extract<RegionalFieldDriveResource["spatial_profile"], { kind: "sinc" }>,
  errors: string[],
): void {
  if (!Number.isFinite(profile.period_m) || profile.period_m <= 0) errors.push("Spatial sinc period must be finite and positive.");
  if (profile.axis.length !== 3 || !profile.axis.every(Number.isFinite) || Math.hypot(...profile.axis) <= 1e-30) errors.push("Spatial sinc axis must be non-zero.");
  if (profile.width_m != null && (!Number.isFinite(profile.width_m) || profile.width_m <= 0)) errors.push("Spatial sinc width must be finite and positive when set.");
}

function normalizedSinc(value: number): number {
  const z = Math.PI * value;
  if (Math.abs(z) < 1e-4) {
    const z2 = z * z;
    return 1 - z2 / 6 + (z2 * z2) / 120;
  }
  return Math.sin(z) / z;
}

function evaluatePiecewiseLinear(
  points: number[][],
  timeS: number,
): number {
  if (points.length === 0) return 0;
  if (timeS <= points[0][0]) return points[0][1];
  if (timeS >= points[points.length - 1][0]) {
    return points[points.length - 1][1];
  }
  const upper = points.findIndex(([time]) => time >= timeS);
  const [t0, value0] = points[upper - 1];
  const [t1, value1] = points[upper];
  return value0 + ((timeS - t0) / (t1 - t0)) * (value1 - value0);
}
