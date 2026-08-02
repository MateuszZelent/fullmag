import { resolveChartUnit } from "../domain/analysis/chartUnits";
import {
  axisScaleFromExtrema,
  formatScaledTooltipValue,
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
): ChartDisplayTransform {
  const policy = resolveChartScalePolicy(unit);
  if (policy.kind === "dimensionless") {
    return {
      factor: 1,
      displayUnit: "",
      formatValue: (value) => formatTooltipValue(value, ""),
    };
  }
  if (policy.kind === "fixed") {
    return {
      factor: policy.factor,
      displayUnit: policy.displayUnit,
      formatValue: (value) =>
        formatTooltipValue(value / policy.factor, policy.displayUnit),
    };
  }

  const scale = extrema
    ? axisScaleFromExtrema(extrema[0], extrema[1], true)
    : { factor: 1, prefix: "" };
  return {
    factor: scale.factor,
    displayUnit: `${scale.prefix}${policy.canonicalUnit}`,
    formatValue: (value) =>
      formatScaledTooltipValue(value, policy.canonicalUnit, scale),
  };
}

export function chartAxisName(
  label: string,
  transform: ChartDisplayTransform,
): string {
  const safeLabel = sanitizeLabelText(label);
  const displayUnit = sanitizeLabelText(transform.displayUnit);
  return displayUnit ? `${safeLabel} [${displayUnit}]` : safeLabel;
}
