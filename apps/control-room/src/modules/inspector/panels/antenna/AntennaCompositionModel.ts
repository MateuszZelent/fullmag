function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, unit = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(4)}${unit ? ` ${unit}` : ""}`
    : `unavailable${unit ? ` ${unit}` : ""}`;
}

export function antennaWaveformBandwidthValue(value: unknown): string {
  const declaration = recordValue(value);
  if (!declaration) return "not declared";
  return typeof declaration.f_max_hz === "number" && Number.isFinite(declaration.f_max_hz)
    ? numberValue(declaration.f_max_hz, "Hz")
    : "invalid declaration";
}
