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
  nyquistStatus: "fail" | "pass" | "preview";
  nyquistMessage: string;
  maximumSamplePeriodForCutoffS: number;
  cutoffHz: number;
  t0S: number;
  leftOfCenterS: number;
  rightOfCenterS: number;
  isSymmetricWindow: boolean;
  symmetryMessage: string;
}

export interface HalfOpenSamplingClock {
  durationS: number;
  frequencyResolutionHz: number;
  nyquistHz: number;
  sampleCount: number;
  samplePeriodS: number;
}

const MAX_FFT_SAMPLES = 16_384;
const MAX_SPECTRUM_BINS = 192;

export function buildSincPulsePreview(input: SincPulsePreviewInput): SincPulsePreviewModel {
  const fallbackDuration = Math.max(2 * Math.max(input.t0S, 0), 8 / input.cutoffHz);
  const durationS = validPositive(input.durationS) ? input.durationS : fallbackDuration;
  const declaredSamplePeriodS = validPositive(input.samplePeriodS) ? input.samplePeriodS : null;
  const hasDeclaredSampling = declaredSamplePeriodS !== null;
  const samplePeriodS = declaredSamplePeriodS ?? durationS / 256;
  const sampleCount = resolveHalfOpenSamplingClock(
    durationS,
    samplePeriodS,
  )?.sampleCount ?? 0;
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
  const frequencyResolutionHz = 1 / (sampleCount * samplePeriodS);
  const nyquistHz = 1 / (2 * samplePeriodS);
  const maximumSamplePeriodForCutoffS = 1 / (2 * input.cutoffHz);
  const maximumPositiveBin = Math.floor(sampleCount / 2);
  const relevantMaximumHz = Math.min(
    nyquistHz,
    Math.max(2 * input.cutoffHz, MAX_SPECTRUM_BINS * frequencyResolutionHz),
  );
  const relevantMaximumBin = Math.min(
    maximumPositiveBin,
    Math.ceil(relevantMaximumHz / frequencyResolutionHz),
  );
  const spectrumPointCount = Math.min(
    relevantMaximumBin + 1,
    MAX_SPECTRUM_BINS + 1,
  );
  const spectrumBins = Array.from({ length: spectrumPointCount }, (_, index) =>
    spectrumPointCount === 1
      ? 0
      : Math.round(index * relevantMaximumBin / (spectrumPointCount - 1)),
  );
  const spectrum = spectrumBins.map((frequencyIndex) => {
    let real = 0;
    let imaginary = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const phase = -2 * Math.PI * frequencyIndex * sampleIndex / sampleCount;
      const value = waveform[sampleIndex].value;
      real += value * Math.cos(phase);
      imaginary += value * Math.sin(phase);
    }
    return {
      frequencyHz: frequencyIndex * frequencyResolutionHz,
      magnitude: Math.hypot(real, imaginary) / sampleCount,
    };
  });
  const leftOfCenterS = Math.max(input.t0S, 0);
  const rightOfCenterS = Math.max(durationS - input.t0S, 0);
  const symmetryToleranceS = Math.max(samplePeriodS * 0.5, durationS * 1e-12);
  const isSymmetricWindow =
    input.t0S >= 0 &&
    input.t0S <= durationS &&
    Math.abs(leftOfCenterS - rightOfCenterS) <= symmetryToleranceS;
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
    frequencyResolutionHz,
    nyquistHz,
    nyquistStatus: hasDeclaredSampling
      ? nyquistHz + Math.abs(input.cutoffHz) * 1e-12 >= input.cutoffHz
        ? "pass"
        : "fail"
      : "preview",
    nyquistMessage: hasDeclaredSampling
      ? nyquistHz + Math.abs(input.cutoffHz) * 1e-12 >= input.cutoffHz
        ? "The effective t_sampling satisfies Nyquist for the authored sinc cutoff."
        : "The effective t_sampling violates Nyquist: the antenna cutoff exceeds the response Nyquist frequency."
      : "Nyquist verification is provisional until an effective table-autosave t_sampling is declared.",
    maximumSamplePeriodForCutoffS,
    cutoffHz: input.cutoffHz,
    t0S: input.t0S,
    leftOfCenterS,
    rightOfCenterS,
    isSymmetricWindow,
    symmetryMessage: isSymmetricWindow
      ? "The sampled time window is symmetric around t0."
      : "The sampled time window is asymmetric around t0; the sinc tail is truncated unequally.",
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
    nyquistStatus: "preview",
    nyquistMessage:
      "Nyquist verification is unavailable until the sampling clock is valid.",
    maximumSamplePeriodForCutoffS: validPositive(input.cutoffHz)
      ? 1 / (2 * input.cutoffHz)
      : 0,
    cutoffHz: input.cutoffHz,
    t0S: input.t0S,
    leftOfCenterS: Math.max(input.t0S, 0),
    rightOfCenterS: Math.max(durationS - input.t0S, 0),
    isSymmetricWindow: false,
    symmetryMessage: "Sinc window symmetry is unavailable until the sampling clock is valid.",
  };
}

export function resolveHalfOpenSamplingClock(
  durationS: number,
  samplePeriodS: number,
): HalfOpenSamplingClock | null {
  if (!validPositive(durationS) || !validPositive(samplePeriodS)) return null;
  const ratio = durationS / samplePeriodS;
  const nearestInteger = Math.round(ratio);
  const sampleCount =
    Math.abs(ratio - nearestInteger) <= 1e-12 * Math.max(1, Math.abs(ratio))
      ? nearestInteger
      : Math.ceil(ratio);
  return {
    durationS,
    frequencyResolutionHz: 1 / (sampleCount * samplePeriodS),
    nyquistHz: 1 / (2 * samplePeriodS),
    sampleCount,
    samplePeriodS,
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
