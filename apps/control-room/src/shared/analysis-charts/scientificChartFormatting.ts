/**
 * scientificChartFormatting.ts — safe, unit-aware formatters for chart axes,
 * tooltips and data labels. All functions:
 *   - never accept `any`
 *   - never produce raw HTML from untrusted data
 *   - handle NaN, Infinity, and null/undefined values explicitly
 *   - respect SI-prefix notation for large/small numbers
 *
 * Auto-scaling strategy (§ axisScale):
 *   Given a set of raw data values, we compute a single shared SI scale factor
 *   that makes tick labels clean integers or short decimals (e.g. 1, 2, 3 instead
 *   of 1e-9, 2e-9, 3e-9). The multiplied prefix is returned separately and should
 *   be appended to the axis unit label: "time [ns]" instead of "time [s]".
 */

/** Sanitize a string for safe inclusion in chart labels (no HTML injection). */
export function sanitizeLabelText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const str = String(raw);
  // Strip HTML tags entirely — ECharts rich text mode is used instead.
  return str.replace(/<[^>]*>/g, "").slice(0, 120);
}

export type ScientificPrecision = 2 | 3 | 4 | 5 | 6;

// ===== SI Scale Detection =====

export interface AxisScale {
  /** Division factor: raw_value / factor = display_value */
  factor: number;
  /** SI prefix string: "n", "µ", "m", "", "k", "M", "G", "T" */
  prefix: string;
}

const SI_SCALES: readonly { factor: number; prefix: string }[] = [
  { factor: 1e12, prefix: "T" },
  { factor: 1e9, prefix: "G" },
  { factor: 1e6, prefix: "M" },
  { factor: 1e3, prefix: "k" },
  { factor: 1, prefix: "" },
  { factor: 1e-3, prefix: "m" },
  { factor: 1e-6, prefix: "µ" },
  { factor: 1e-9, prefix: "n" },
  { factor: 1e-12, prefix: "p" },
];

/**
 * Compute the best SI scale for a set of values so that display values
 * fall in the range [1, 1000) when possible.
 *
 * Returns factor=1, prefix="" when values span many orders of magnitude
 * (mixed-scale data) or when all values are zero.
 */
export function detectAxisScale(values: Iterable<number>): AxisScale {
  let absMax = 0;
  let absMin = Number.POSITIVE_INFINITY;
  let hasFiniteNonZeroValue = false;
  for (const value of values) {
    if (!Number.isFinite(value) || value === 0) continue;
    const magnitude = Math.abs(value);
    absMax = Math.max(absMax, magnitude);
    absMin = Math.min(absMin, magnitude);
    hasFiniteNonZeroValue = true;
  }

  return axisScaleFromExtrema(absMin, absMax, hasFiniteNonZeroValue);
}

/** Builds an SI scale from finite, non-zero absolute extrema. */
export function axisScaleFromExtrema(
  absMin: number,
  absMax: number,
  hasFiniteNonZeroValue: boolean,
): AxisScale {
  if (!hasFiniteNonZeroValue) return { factor: 1, prefix: "" };

  // If span is more than 3 orders of magnitude, don't auto-scale
  if (absMax / absMin > 1e3) return { factor: 1, prefix: "" };

  // Pick the scale based on the representative magnitude (geometric mean of extrema)
  const representative = Math.sqrt(absMax * absMin);
  for (const scale of SI_SCALES) {
    if (representative >= scale.factor * 0.5) {
      return scale;
    }
  }
  return { factor: 1e-12, prefix: "p" };
}

/**
 * Parse a label string that may contain pre-formatted unit brackets like "t [s]".
 * Returns the base label ("t") and unit ("s").
 */
export function parseLabelAndUnit(
  label: string,
  fallbackUnit: string,
): { baseLabel: string; unit: string } {
  if (!label) return { baseLabel: "", unit: fallbackUnit };
  const match = label.match(/^(.*?)\s*\[(.*?)\]$/);
  if (match) {
    return { baseLabel: match[1].trim(), unit: match[2].trim() };
  }
  return { baseLabel: label.trim(), unit: fallbackUnit.trim() };
}

/**
 * Build an axis name that incorporates both the label and the SI-prefixed unit.
 * e.g.: label="time", unit="s", prefix="n" → "time [ns]"
 * e.g.: label="t [s]", unit="s", prefix="n" → "t [ns]"
 */
export function formatAxisNameWithScale(
  label: string,
  unit: string,
  scale: AxisScale,
): string {
  const parsed = parseLabelAndUnit(label, unit);
  const safeLabel = sanitizeLabelText(parsed.baseLabel);
  const safeUnit = sanitizeLabelText(parsed.unit);
  const fullUnit = scale.prefix + safeUnit;
  if (!safeLabel && !fullUnit) return "";
  if (!fullUnit) return safeLabel;
  if (!safeLabel) return `[${fullUnit}]`;
  return `${safeLabel} [${fullUnit}]`;
}

// ===== Tick Formatters =====

/**
 * Format a numeric value for axis labels with SI prefix handling.
 * Returns a plain-text string; safe to include in ECharts plain tooltips.
 */
export function formatAxisValue(
  value: number,
  precision: ScientificPrecision = 4,
): string {
  if (!Number.isFinite(value)) return value === Infinity ? "∞" : value === -Infinity ? "-∞" : "—";
  if (value === 0) return "0";

  const abs = Math.abs(value);
  if (abs >= 1e15 || (abs < 1e-12 && abs !== 0)) {
    return value.toExponential(precision - 1);
  }
  // SI prefix shorthand for axis ticks
  if (abs >= 1e12) return `${trimTrailingZeros((value / 1e12).toFixed(precision - 1))} T`;
  if (abs >= 1e9)  return `${trimTrailingZeros((value / 1e9).toFixed(precision - 1))} G`;
  if (abs >= 1e6)  return `${trimTrailingZeros((value / 1e6).toFixed(precision - 1))} M`;
  if (abs >= 1e3)  return `${trimTrailingZeros((value / 1e3).toFixed(precision - 1))} k`;
  if (abs >= 1)    return trimTrailingZeros(value.toPrecision(precision));
  if (abs >= 1e-3) return trimTrailingZeros(value.toPrecision(precision));
  if (abs >= 1e-6) return `${trimTrailingZeros((value * 1e6).toFixed(precision - 1))} µ`;
  if (abs >= 1e-9) return `${trimTrailingZeros((value * 1e9).toFixed(precision - 1))} n`;
  if (abs >= 1e-12) return `${trimTrailingZeros((value * 1e12).toFixed(precision - 1))} p`;
  return value.toExponential(precision - 1);
}

/**
 * Format a raw data value using a pre-computed AxisScale.
 * The result is a clean number (e.g., "1.5" for 1.5e-9 with ns scale).
 */
export function formatScaledAxisValue(
  value: number,
  scale: AxisScale,
  precision: ScientificPrecision = 4,
): string {
  if (!Number.isFinite(value)) return value === Infinity ? "∞" : value === -Infinity ? "-∞" : "—";
  if (value === 0) return "0";
  const scaled = value / scale.factor;
  const abs = Math.abs(scaled);
  if (abs >= 1e6 || abs < 1e-3) {
    return scaled.toExponential(precision - 1);
  }
  return trimTrailingZeros(scaled.toPrecision(precision));
}

function trimTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/**
 * Format a data value for tooltip display with unit.
 * Uses full precision (5 significant figures) per plan §6.4.
 */
export function formatTooltipValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  const formatted =
    Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)
      ? value.toExponential(4)
      : String(Number(value.toPrecision(5)));
  return unit ? `${formatted} ${sanitizeLabelText(unit)}` : formatted;
}

/**
 * Format a tooltip value with auto-scale applied.
 * Shows scaled value with SI prefix unit.
 */
export function formatScaledTooltipValue(
  value: number,
  unit: string,
  scale: AxisScale,
): string {
  if (!Number.isFinite(value)) return "—";
  const scaled = value / scale.factor;
  const formatted =
    Math.abs(scaled) >= 1e4 || (scaled !== 0 && Math.abs(scaled) < 1e-3)
      ? scaled.toExponential(4)
      : String(Number(scaled.toPrecision(5)));
  const fullUnit = scale.prefix + sanitizeLabelText(unit);
  return fullUnit ? `${formatted} ${fullUnit}` : formatted;
}

/**
 * Build a plain-text axis name from label and unit.
 * Safe against XSS since ECharts `name` is plain text in Canvas mode.
 */
export function formatAxisName(label: string, unit: string): string {
  const safeLabel = sanitizeLabelText(label);
  const safeUnit = sanitizeLabelText(unit);
  if (!safeLabel && !safeUnit) return "";
  if (!safeUnit) return safeLabel;
  if (!safeLabel) return `[${safeUnit}]`;
  return `${safeLabel} [${safeUnit}]`;
}

/**
 * ECharts axis `axisLabel.formatter` factory — plain SI formatting.
 * Returns a function that formats tick values using SI prefixes.
 */
export function axisLabelFormatter(
  precision: ScientificPrecision = 4,
): (value: number) => string {
  return (value: number) => formatAxisValue(value, precision);
}

/**
 * ECharts axis `axisLabel.formatter` factory — scaled formatting.
 * Divides each tick by `scale.factor` so labels become clean numbers.
 */
export function scaledAxisLabelFormatter(
  scale: AxisScale,
  precision: ScientificPrecision = 4,
): (value: number) => string {
  return (value: number) => formatScaledAxisValue(value, scale, precision);
}
