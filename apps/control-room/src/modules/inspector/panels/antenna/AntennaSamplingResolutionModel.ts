import { MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT } from "./AntennaSpectrumComposerModel";
import type { AntennaSpectrumDraft } from "./AntennaSpectrumComposerModel";

export type AntennaSamplingGridDraft = Pick<AntennaSpectrumDraft, "extentUM" | "extentVM" | "samplesU" | "samplesV">;

/** Matches antenna_spectrum.rs::validated_uniform_plane_lattice and fft_frequencies, without allocating a grid. */
export function antennaSamplingResolution(values: AntennaSamplingGridDraft, transform = "spatial_fft") {
  if (transform !== "spatial_fft") return null;
  const entries = [values.extentUM, values.extentVM, values.samplesU, values.samplesV];
  if (entries.some(value => !value.trim())) return null;
  const [extentU, extentV, countU, countV] = entries.map(Number);
  if (![extentU, extentV].every(value => Number.isFinite(value) && value > 0)
    || ![countU, countV].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 4294967295)) return null;
  const sampleCount = countU * countV;
  if (!Number.isSafeInteger(sampleCount)) return null;
  const axis = (extent: number, count: number) => {
    const spacingM = extent / (count - 1);
    const deltaKRadPerM = 2 * Math.PI / (count * spacingM);
    const minimumKRadPerM = -Math.floor(count / 2) * deltaKRadPerM;
    const maximumKRadPerM = Math.floor((count - 1) / 2) * deltaKRadPerM;
    if (![spacingM, deltaKRadPerM].every(value => Number.isFinite(value) && value > 0)
      || ![minimumKRadPerM, maximumKRadPerM].every(Number.isFinite)) return null;
    return { count, spacingM, deltaKRadPerM, minimumKRadPerM, maximumKRadPerM };
  };
  const u = axis(extentU, countU), v = axis(extentV, countV);
  return u && v ? { sampleCount, limit: MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT, withinBudget: sampleCount <= MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT, u, v } : null;
}
