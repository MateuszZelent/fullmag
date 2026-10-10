import {
  phasorAdapter,
  type PhasorConvention,
} from "./phasorConventionAdapter";

export type ModalStability =
  | "decaying"
  | "growing"
  | "undamped"
  | "not available";

export interface ModalDampingObservables {
  decayRateHz: number | null;
  stability: ModalStability;
  linewidthFwhmHz: number | null;
  qualityFactor: number | null;
  lifetimeSeconds: number | null;
}

// JSON numbers and nonempty legacy numeric strings only; null/false are not zero.
export function finiteModalScalar(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function modalDampingObservables(
  realFrequencyHz: number | null,
  imaginaryFrequencyHz: number | null,
  phaseConvention: string | null,
): ModalDampingObservables {
  if (
    realFrequencyHz === null ||
    !Number.isFinite(realFrequencyHz) ||
    imaginaryFrequencyHz === null ||
    !Number.isFinite(imaginaryFrequencyHz) ||
    !isPhasorConvention(phaseConvention)
  ) {
    return unavailableObservables();
  }

  const { decayRateSign } = phasorAdapter(phaseConvention);
  // Both phasors describe the same undamped zero; retain nonzero growth signs.
  const decayRateHz = imaginaryFrequencyHz === 0 ? 0 : decayRateSign * imaginaryFrequencyHz;
  if (!Number.isFinite(decayRateHz)) {
    return unavailableObservables();
  }

  const stability: ModalStability =
    decayRateHz > 0
      ? "decaying"
      : decayRateHz < 0
        ? "growing"
        : "undamped";

  const linewidthCandidate =
    realFrequencyHz !== 0 && decayRateHz >= 0
      ? 2 * decayRateHz
      : null;
  const linewidthFwhmHz =
    linewidthCandidate !== null && Number.isFinite(linewidthCandidate)
      ? linewidthCandidate
      : null;

  const qualityCandidate =
    linewidthFwhmHz !== null && linewidthFwhmHz > 0
      ? Math.abs(realFrequencyHz) / linewidthFwhmHz
      : null;
  const qualityFactor =
    qualityCandidate !== null && Number.isFinite(qualityCandidate)
      ? qualityCandidate
      : null;

  const lifetimeCandidate =
    decayRateHz > 0
      ? 1 / (2 * Math.PI) / decayRateHz
      : null;
  const lifetimeSeconds =
    lifetimeCandidate !== null &&
    Number.isFinite(lifetimeCandidate) &&
    lifetimeCandidate > 0
      ? lifetimeCandidate
      : null;

  return {
    decayRateHz,
    stability,
    linewidthFwhmHz,
    qualityFactor,
    lifetimeSeconds,
  };
}

function isPhasorConvention(
  value: string | null,
): value is PhasorConvention {
  return value === "exp_i_omega_t" || value === "exp_minus_i_omega_t";
}

function unavailableObservables(): ModalDampingObservables {
  return {
    decayRateHz: null,
    stability: "not available",
    linewidthFwhmHz: null,
    qualityFactor: null,
    lifetimeSeconds: null,
  };
}