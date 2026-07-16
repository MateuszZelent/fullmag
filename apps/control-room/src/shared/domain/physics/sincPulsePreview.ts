export interface SincPulsePreviewInput {
  cutoffHz: number;
  t0S: number;
  waveformAmplitude: number;
  fieldAmplitudeT: number;
  samplePeriodS: number | null;
  durationS: number | null;
}

export interface SincPulsePreviewModel {
  status: "ready" | "preview_only" | "unavailable";
  message: string | null;
  waveform: Array<{ timeS: number; value: number }>;
  spectrum: Array<{ frequencyHz: number; magnitude: number }>;
  samplePeriodS: number;
  sampleCount: number;
  durationS: number;
  frequencyResolutionHz: number;
  nyquistHz: number;
  cutoffHz: number;
  t0S: number;
}

const MAX_FFT_SAMPLES = 16_384;
const MAX_SPECTRUM_BINS = 192;

export function buildSincPulsePreview(input: SincPulsePreviewInput): SincPulsePreviewModel {
  const fallbackDuration = Math.max(2 * Math.max(input.t0S, 0), 8 / input.cutoffHz);
  const durationS = validPositive(input.durationS) ? input.durationS : fallbackDuration;
  const declaredSamplePeriodS = validPositive(input.samplePeriodS) ? input.samplePeriodS : null;
  const hasDeclaredSampling = declaredSamplePeriodS !== null;
  const samplePeriodS = declaredSamplePeriodS ?? durationS / 256;
  const sampleCount = Math.floor(durationS / samplePeriodS) + 1;
  if (!validPositive(input.cutoffHz) || !validPositive(durationS) || !validPositive(samplePeriodS)) {
    return emptyModel(input, "unavailable", "Sinc preview requires finite positive cutoff and time window.");
  }
  if (sampleCount < 4 || sampleCount > MAX_FFT_SAMPLES) {
    return emptyModel(
      input,
      "unavailable",
      `FFT preview requires 4–${MAX_FFT_SAMPLES} samples; current settings imply ${sampleCount}.`,
      samplePeriodS,
      durationS,
      sampleCount,
    );
  }
  const waveform = Array.from({ length: sampleCount }, (_, index) => {
    const timeS = index * samplePeriodS;
    const x = 2 * input.cutoffHz * (timeS - input.t0S);
    return {
      timeS,
      value: input.fieldAmplitudeT * input.waveformAmplitude * normalizedSinc(x),
    };
  });
  const binCount = Math.min(Math.floor(sampleCount / 2), MAX_SPECTRUM_BINS);
  const spectrum = Array.from({ length: binCount + 1 }, (_, frequencyIndex) => {
    let real = 0;
    let imaginary = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const phase = -2 * Math.PI * frequencyIndex * sampleIndex / sampleCount;
      const value = waveform[sampleIndex].value;
      real += value * Math.cos(phase);
      imaginary += value * Math.sin(phase);
    }
    return {
      frequencyHz: frequencyIndex / (sampleCount * samplePeriodS),
      magnitude: Math.hypot(real, imaginary) / sampleCount,
    };
  });
  return {
    status: hasDeclaredSampling ? "ready" : "preview_only",
    message: hasDeclaredSampling
      ? null
      : "FFT uses preview sampling. Configure table autosave t_sampling for response-grade dt/df/Nyquist.",
    waveform,
    spectrum,
    samplePeriodS,
    sampleCount,
    durationS,
    frequencyResolutionHz: 1 / (sampleCount * samplePeriodS),
    nyquistHz: 1 / (2 * samplePeriodS),
    cutoffHz: input.cutoffHz,
    t0S: input.t0S,
  };
}

function emptyModel(
  input: SincPulsePreviewInput,
  status: SincPulsePreviewModel["status"],
  message: string,
  samplePeriodS = 0,
  durationS = 0,
  sampleCount = 0,
): SincPulsePreviewModel {
  return {
    status,
    message,
    waveform: [],
    spectrum: [],
    samplePeriodS,
    sampleCount,
    durationS,
    frequencyResolutionHz: 0,
    nyquistHz: 0,
    cutoffHz: input.cutoffHz,
    t0S: input.t0S,
  };
}

function validPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function normalizedSinc(value: number): number {
  const z = Math.PI * value;
  if (Math.abs(z) < 1e-4) {
    const z2 = z * z;
    return 1 - z2 / 6 + (z2 * z2) / 120;
  }
  return Math.sin(z) / z;
}
