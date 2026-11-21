export function formatScientific(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-3) return value.toExponential(4);
  return value.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}
