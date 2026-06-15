export function formatFrequencyHz(valueHz: number | null | undefined): string {
  if (valueHz == null || !Number.isFinite(valueHz)) return "not available";
  const abs = Math.abs(valueHz);
  if (abs >= 1e9) return `${formatCompact(valueHz / 1e9)} GHz`;
  if (abs >= 1e6) return `${formatCompact(valueHz / 1e6)} MHz`;
  return `${formatCompact(valueHz)} Hz`;
}

export function formatFrequencyRangeHz(valuesHz: readonly number[]): string {
  if (!valuesHz.length) return "not available";
  return `${formatFrequencyHz(Math.min(...valuesHz))}-${formatFrequencyHz(
    Math.max(...valuesHz),
  )}`;
}

export function formatFrequencyRangeBoundsHz(
  minHz: number | null | undefined,
  maxHz: number | null | undefined,
): string {
  if (minHz == null || maxHz == null) return "not available";
  return `${formatFrequencyHz(minHz)}-${formatFrequencyHz(maxHz)}`;
}

function formatCompact(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(2);
  }
  return Number(value.toPrecision(4)).toLocaleString("en-US");
}
