export const AUTO_SINC_NYQUIST_GUARD_FACTOR = 1.3;

export interface ReadyAutoSincSampling {
  maximumCutoffHz: number;
  nyquistGuardFactor: number;
  samplePeriodS: number;
  samplingFrequencyHz: number;
  status: "ready";
  targetNyquistHz: number;
}

export interface UnresolvedAutoSincSampling {
  reason: string;
  status: "unresolved";
}

export type AutoSincSamplingResult =
  | ReadyAutoSincSampling
  | UnresolvedAutoSincSampling;

export function resolveAutoSincSampling({
  cutoffHz,
}: {
  cutoffHz: readonly number[];
}): AutoSincSamplingResult {
  if (cutoffHz.length === 0) {
    return {
      reason:
        "No active sinc drive with a finite positive cutoff applies to this Run.",
      status: "unresolved",
    };
  }
  if (cutoffHz.some((cutoff) => !Number.isFinite(cutoff) || cutoff <= 0)) {
    return {
      reason:
        "Every active sinc drive must have a finite positive cutoff for automatic sampling.",
      status: "unresolved",
    };
  }

  const maximumCutoffHz = Math.max(...cutoffHz);
  const targetNyquistHz =
    AUTO_SINC_NYQUIST_GUARD_FACTOR * maximumCutoffHz;
  const samplingFrequencyHz = 2 * targetNyquistHz;
  return {
    maximumCutoffHz,
    nyquistGuardFactor: AUTO_SINC_NYQUIST_GUARD_FACTOR,
    samplePeriodS: 1 / samplingFrequencyHz,
    samplingFrequencyHz,
    status: "ready",
    targetNyquistHz,
  };
}
