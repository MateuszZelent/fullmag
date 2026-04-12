/**
 * Shared number formatting utilities for the Fullmag control room.
 *
 * Single source of truth — all components should import from here.
 */

type DisplayContext = "value" | "axis" | "legend";

interface DisplayUnitPolicy {
  displayUnit: string;
  allowPrefixes: boolean;
  allowSubPrefixes?: boolean;
}

const PREFIX_STEPS = [
  { factor: 1e12, prefix: "T" },
  { factor: 1e9, prefix: "G" },
  { factor: 1e6, prefix: "M" },
  { factor: 1e3, prefix: "k" },
  { factor: 1, prefix: "" },
  { factor: 1e-3, prefix: "m" },
  { factor: 1e-6, prefix: "µ" },
  { factor: 1e-9, prefix: "n" },
  { factor: 1e-12, prefix: "p" },
] as const;

export function displayUnitPolicy(
  quantityId: string | null | undefined,
  canonicalUnit: string,
  _context: DisplayContext = "value",
): DisplayUnitPolicy {
  void quantityId;
  switch (canonicalUnit) {
    case "":
    case "dimensionless":
      return { displayUnit: "", allowPrefixes: false };
    case "rad":
      return { displayUnit: "rad", allowPrefixes: false };
    case "1/s":
      return { displayUnit: "s^-1", allowPrefixes: true, allowSubPrefixes: true };
    case "A/m":
    case "J":
    case "J/m":
    case "J/m^3":
    case "J/m³":
    case "m":
    case "s":
    case "Hz":
      return { displayUnit: normalizeUnitLabel(canonicalUnit), allowPrefixes: true };
    default:
      return { displayUnit: normalizeUnitLabel(canonicalUnit), allowPrefixes: false };
  }
}

export function normalizeUnitLabel(unit: string): string {
  switch (unit) {
    case "":
    case "dimensionless":
      return "";
    case "J/m³":
      return "J/m^3";
    case "1/s":
      return "s^-1";
    default:
      return unit;
  }
}

export function fmtSI(v: number, unit: string, quantityId?: string): string {
  const policy = displayUnitPolicy(quantityId, unit);
  if (!Number.isFinite(v) || v === 0) {
    return policy.displayUnit ? `0 ${policy.displayUnit}` : "0";
  }
  if (!policy.allowPrefixes) {
    return policy.displayUnit ? `${v.toPrecision(3)} ${policy.displayUnit}` : `${v.toPrecision(3)}`;
  }
  const abs = Math.abs(v);
  const prefixSteps = policy.allowSubPrefixes
    ? PREFIX_STEPS
    : PREFIX_STEPS.filter((step) => step.factor >= 1 || step.prefix === "");
  const chosen = prefixSteps.find((step) => abs >= step.factor) ?? prefixSteps[prefixSteps.length - 1];
  const scaled = v / chosen.factor;
  const unitLabel = `${chosen.prefix}${policy.displayUnit}`;
  const valueLabel = chosen.factor === 1e-12 && abs < 1e-12
    ? v.toExponential(2)
    : scaled.toPrecision(3);
  return unitLabel ? `${valueLabel} ${unitLabel}` : valueLabel;
}

export function fmtExp(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  return v.toExponential(3);
}

export function fmtTime(t: number): string {
  return fmtSI(t, "s");
}

export function fmtStepValue(v: number, enabled: boolean): string {
  return enabled ? v.toLocaleString() : "—";
}

export function fmtSIOrDash(v: number, unit: string, enabled: boolean): string {
  return enabled ? fmtSI(v, unit) : "—";
}

export function fmtExpOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtExp(v) : "—";
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  return `${(ms / 3600000).toFixed(2)} h`;
}

export function fmtPreviewMaxPoints(value: number): string {
  if (value <= 0) return "Full";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return value.toLocaleString();
}

export function fmtPreviewEveryN(n: number): string {
  return n <= 1 ? "Every step" : `Every ${n} steps`;
}
