import { evaluateDriveWaveform } from "@/shared/domain/physics/fieldDrive";
import type { ChartRenderPoint } from "@/shared/analysis-charts/chartRenderer";
import type { SolvedDrive } from "./SolvedAntennaDriveEditorModel";

export const MAX_DRIVE_PREVIEW_POINTS = 1025;

export function defaultDrivePreviewRange(drive: SolvedDrive): [number, number] {
  const w = drive.waveform;
  switch (w.kind) {
    case "constant": return [0, 1e-9];
    case "sinusoidal": return [0, 2 / w.frequency_hz];
    case "sinc_pulse": return [(w.t0 ?? 0) - 2 / w.cutoff_hz, (w.t0 ?? 0) + 2 / w.cutoff_hz];
    case "pulse": { const span = w.t_off - w.t_on; return [w.t_on - span / 4, w.t_off + span / 4]; }
    case "piecewise_linear": return [w.points[0][0], w.points[w.points.length - 1][0]];
  }
}

/** Sample the authored multiplier; this is neither a solver result nor an activation gate. */
export function sampleAntennaDrive(drive: SolvedDrive, from: number, to: number): ChartRenderPoint[] {
  const span = to - from, w = drive.waveform;
  if (![from, to, span].every(Number.isFinite) || span <= 0) throw new Error("Preview requires a finite, increasing time range.");
  const cycles = w.kind === "sinusoidal" ? span * w.frequency_hz : w.kind === "sinc_pulse" ? span * 2 * w.cutoff_hz : 0;
  if (!Number.isFinite(cycles) || cycles > 16) throw new Error("Reduce the preview time range to at most 16 oscillations; the plot will not alias a longer interval.");
  if (w.kind === "piecewise_linear" && w.points.length > 512) throw new Error("Preview supports at most 512 authored knots. The drive can still be saved.");
  const intervals = Math.max(128, Math.ceil(cycles * 32));
  const times = new Set(Array.from({ length: intervals + 1 }, (_, i) => from + span * (i / intervals)));
  if (w.kind === "piecewise_linear") for (const [time] of w.points) if (time >= from && time <= to) times.add(time);
  if (w.kind === "sinc_pulse" && (w.t0 ?? 0) >= from && (w.t0 ?? 0) <= to) times.add(w.t0 ?? 0);
  const samples = [...times].sort((a, b) => a - b).flatMap(time => [{ x: time, y: evaluateDriveWaveform(drive, time) }]);
  // Duplicate boundary coordinates represent one-sided limits without smearing a narrow pulse.
  if (w.kind === "pulse") {
    for (const [time, leftTime] of [[w.t_on, w.t_on - (w.t_off - w.t_on)], [w.t_off, w.t_on]]) {
      if (time < from || time > to) continue;
      const index = samples.findIndex(point => point.x >= time);
      if (index >= 0 && samples[index].x === time) samples.splice(index, 1);
      samples.splice(index < 0 ? samples.length : index, 0,
        { x: time, y: evaluateDriveWaveform(drive, leftTime) }, { x: time, y: evaluateDriveWaveform(drive, time) });
    }
  }
  if (samples.length > MAX_DRIVE_PREVIEW_POINTS) throw new Error("Preview sample budget exceeded.");
  return samples.map((point, rowIndex) => {
    const y = point.y * drive.peak_current_a;
    if (!Number.isFinite(y)) throw new Error("Preview current overflow. Review the current scale and waveform amplitude.");
    return { x: point.x, y, rowIndex };
  });
}
