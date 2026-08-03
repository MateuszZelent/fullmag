import { chartUnitsCompatible, resolveChartUnit } from "../domain/analysis/chartUnits";
import {
  axisScaleFromExtrema,
  formatTooltipValue,
  sanitizeLabelText,
} from "./scientificChartFormatting";

export type ChartScalePolicy =
  | { kind: "fixed"; factor: number; displayUnit: string }
  | { kind: "si-prefix"; canonicalUnit: string }
  | { kind: "dimensionless"; displayUnit: "" };

export interface ChartDisplayTransform {
  factor: number;
  displayUnit: string;
  formatValue(value: number): string;
}

interface ChartYAxisSeries {
  points: readonly { y: number }[];
  yAxis: number;
}

export function chartValueExtrema(
  values: Iterable<number>,
): readonly [number, number] | null {
  let absMax = 0;
  let absMin = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value) || value === 0) continue;
    const magnitude = Math.abs(value);
    absMax = Math.max(absMax, magnitude);
    absMin = Math.min(absMin, magnitude);
  }
  return Number.isFinite(absMin) ? [absMin, absMax] : null;
}

export function formatChartDisplayValue(
  value: number,
  transform: ChartDisplayTransform,
): string {
  return formatTooltipValue(value / transform.factor, "");
}

export function createChartYAxisDisplayTransforms(
  axes: readonly { unit: string }[],
  series: readonly ChartYAxisSeries[],
  preferredUnits: readonly (string | null | undefined)[] = [],
): ChartDisplayTransform[] {
  let axisCount = Math.max(axes.length, 1);
  for (const entry of series) axisCount = Math.max(axisCount, entry.yAxis + 1);
  const extrema = Array.from({ length: axisCount }, () => ({
    absMax: 0,
    absMin: Number.POSITIVE_INFINITY,
    hasFiniteNonZeroValue: false,
  }));
  for (const entry of series) {
    const axis = extrema[entry.yAxis];
    if (!axis) continue;
    for (const point of entry.points) {
      if (!Number.isFinite(point.y) || point.y === 0) continue;
      const magnitude = Math.abs(point.y);
      axis.absMax = Math.max(axis.absMax, magnitude);
      axis.absMin = Math.min(axis.absMin, magnitude);
      axis.hasFiniteNonZeroValue = true;
    }
  }
  return extrema.map((axis, index) =>
    createChartDisplayTransform(
      axes[index]?.unit ?? "",
      axis.hasFiniteNonZeroValue ? [axis.absMin, axis.absMax] : null,
      preferredUnits[index],
    ),
  );
}

export function resolveChartScalePolicy(unit: string): ChartScalePolicy {
  const resolved = resolveChartUnit(unit);
  return resolved?.dimension === "dimensionless"
    ? { kind: "dimensionless", displayUnit: "" }
    : {
        kind: "si-prefix",
        canonicalUnit: resolved?.canonicalUnit ?? unit.trim(),
      };
}

export function createChartDisplayTransform(
  unit: string,
  extrema: readonly [number, number] | null,
  preferredUnit: string | null | undefined = null,
): ChartDisplayTransform {
  const resolved = resolveChartUnit(unit);
  const preferred = preferredUnit && chartUnitsCompatible(unit, preferredUnit)
    ? resolveChartUnit(preferredUnit)
    : null;
  if (preferred && resolved) {
    const transform: ChartDisplayTransform = {
      factor: preferred.scaleToCanonical / resolved.scaleToCanonical,
      displayUnit: preferred.unit === "1" ? "" : preferred.unit,
      formatValue: (value) => `${formatChartDisplayValue(value, transform)}${transform.displayUnit ? ` ${sanitizeLabelText(transform.displayUnit)}` : ""}`,
    };
    return transform;
  }
  const policy = resolveChartScalePolicy(unit);
  if (policy.kind === "dimensionless") {
    const transform: ChartDisplayTransform = {
      factor: 1,
      displayUnit: "",
      formatValue: (value) => formatChartDisplayValue(value, transform),
    };
    return transform;
  }
  if (policy.kind === "fixed") {
    const transform: ChartDisplayTransform = {
      factor: policy.factor,
      displayUnit: policy.displayUnit,
      formatValue: (value) =>
        `${formatChartDisplayValue(value, transform)}${
          policy.displayUnit ? ` ${sanitizeLabelText(policy.displayUnit)}` : ""
        }`,
    };
    return transform;
  }

  const scaleToCanonical = resolved?.scaleToCanonical ?? 1;
  const scale = extrema
    ? axisScaleFromExtrema(
        extrema[0] * scaleToCanonical,
        extrema[1] * scaleToCanonical,
        true,
      )
    : { factor: 1, prefix: "" };
  const transform: ChartDisplayTransform = {
    factor: scale.factor / scaleToCanonical,
    displayUnit: `${scale.prefix}${policy.canonicalUnit}`,
    formatValue: (value) =>
      `${formatChartDisplayValue(value, transform)}${
        transform.displayUnit ? ` ${sanitizeLabelText(transform.displayUnit)}` : ""
      }`,
  };
  return transform;
}

export function chartAxisName(
  label: string,
  transform: ChartDisplayTransform,
): string {
  const safeLabel = sanitizeLabelText(label);
  const displayUnit = sanitizeLabelText(transform.displayUnit);
  return displayUnit ? `${safeLabel} [${displayUnit}]` : safeLabel;
}
