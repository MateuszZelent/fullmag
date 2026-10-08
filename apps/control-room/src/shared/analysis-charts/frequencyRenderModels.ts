import type { ChartRenderModel } from "./chartRenderer";
import {
  FREQUENCY_CHART_POINT_SYMBOL_SIZE,
  frequencyAxisDataRange,
  isFrequencyValueSeries,
} from "./frequencyAxisPresentation";
import type {
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartPoint,
  FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

export function frequencySpectrumRenderModel<
  T extends { dampingRateHz?: number | null; frequencyValue: number; rowIndex: number },
>(
  data: readonly T[],
  frequencyUnit: string,
): ChartRenderModel {
  const hertzPerUnit = frequencyHertzPerUnit(frequencyUnit);
  const envelope = hertzPerUnit == null ? [] : spectralEnvelope(data, hertzPerUnit);
  return {
    ariaLabel: "Eigen modes with illustrative modal envelope",
    key: `frequency-spectrum:${frequencyUnit}:${data.length}:${data.at(-1)?.rowIndex ?? -1}`,
    provenance: {
      dataRevision: null,
      decimation: "none",
      query: `frequencyUnit=${frequencyUnit}`,
      resourceKey: "analysis/frequency-domain/eigen/spectrum",
    },
    series: hertzPerUnit == null ? [] : [
      ...(envelope.length > 0 ? [{
        id: "spectral-envelope",
        kind: "line" as const,
        label: "Illustrative modal envelope",
        points: envelope,
        unit: "a.u.",
        yAxis: 0,
      }] : []),
      {
        id: "modes",
        kind: "scatter" as const,
        label: "Modes",
        symbolSize: FREQUENCY_CHART_POINT_SYMBOL_SIZE,
        points: data.map((point) => ({ rowIndex: point.rowIndex, x: point.frequencyValue, y: 1 })),
        unit: "a.u.",
        yAxis: 0,
      },
    ],
    status: hertzPerUnit == null ? "unsupported" : data.length > 0 ? "ready" : "empty",
    ...(hertzPerUnit == null ? { statusMessage: `Unsupported frequency unit: ${frequencyUnit}` } : {}),
    xAxis: { label: `frequency [${frequencyUnit}]`, unit: frequencyUnit },
    yAxes: [{ label: "normalized modal weight [a.u.]", unit: "a.u." }],
  };
}

function frequencyHertzPerUnit(unit: string): number | null {
  switch (unit) {
    case "Hz": return 1;
    case "kHz": return 1e3;
    case "MHz": return 1e6;
    case "GHz": return 1e9;
    default: return null;
  }
}

function spectralEnvelope(
  data: readonly { dampingRateHz?: number | null; frequencyValue: number }[],
  hertzPerUnit: number,
): { rowIndex: number; x: number; y: number }[] {
  const damped = data.filter((point) =>
    point.dampingRateHz != null && Number.isFinite(point.dampingRateHz) && point.dampingRateHz > 0
  );
  if (damped.length === 0) return [];
  const frequencies = data.map((point) => point.frequencyValue * hertzPerUnit);
  const fMin = Math.min(...frequencies);
  const fMax = Math.max(...frequencies);
  const fRange = fMax - fMin || fMax * 0.1 || 1;
  const fStart = fMin - fRange * 0.15;
  const step = (fRange * 1.3) / 500;
  const points = Array.from({ length: 501 }, (_, rowIndex) => {
    const x = fStart + step * rowIndex;
    const y = damped.reduce((sum, point) => {
      // exp(i omega t): damping_rate_hz is HWHM; FWHM is twice this rate.
      const halfWidthHz = point.dampingRateHz!;
      return sum + 1 / ((x - point.frequencyValue * hertzPerUnit) ** 2 + halfWidthHz ** 2);
    }, 0);
    return { rowIndex, x: x / hertzPerUnit, y };
  });
  const peak = points.reduce((value, point) => Math.max(value, point.y), 0);
  return peak > 0 ? points.map((point) => ({ ...point, y: point.y / peak })) : points;
}

export function frequencySeriesRenderModel(
  series: readonly FrequencyDomainChartSeries[],
  title: string,
  xLabel: string,
): ChartRenderModel {
  const compatible = compatibleFrequencySeries(series);
  const xUnit = compatible[0]?.xUnit ?? "";
  const yUnit = compatible[0]?.unit ?? "";
  const dataRange = frequencyAxisDataRange(compatible);
  return {
    ariaLabel: title,
    key: JSON.stringify([title, ...compatible.map((entry) => [entry.id, entry.points.length, entry.points.at(-1)?.rowIndex])]),
    provenance: {
      dataRevision: null,
      decimation: "none",
      query: xLabel,
      resourceKey: compatible[0]?.source.resourceKey ?? "analysis/frequency-domain",
    },
    series: compatible.map((entry) => ({
      id: entry.id,
      kind: entry.kind ?? "line",
      label: entry.label,
      points: entry.points,
      ...(isFrequencyValueSeries(entry)
        ? { symbolSize: FREQUENCY_CHART_POINT_SYMBOL_SIZE }
        : {}),
      ...(entry.quantity === "analytic_frequency"
        ? { analyticReference: true, showSymbols: true }
        : {}),
      unit: entry.unit,
      yAxis: 0,
    })),
    status: compatible.some((entry) => entry.points.length > 0) ? "ready" : "empty",
    xAxis: { label: resolveFrequencyXAxisLabel(compatible, xLabel), unit: xUnit },
    yAxes: [{ label: frequencyYAxisLabel(compatible), unit: yUnit, ...(dataRange ? { dataRange } : {}) }],
  };
}

export function finiteFrequencySeries<TPoint>(
  model: FrequencyDomainChartBuildResult<TPoint>,
): FrequencyDomainChartSeries[] {
  return model.series.flatMap((series) => {
    const points = series.points.filter(isFiniteFrequencyPoint);
    return points.length > 0 ? [{ ...series, points }] : [];
  });
}

export function compatibleFrequencySeries(
  series: readonly FrequencyDomainChartSeries[],
): readonly FrequencyDomainChartSeries[] {
  const first = series.find((entry) => entry.points.length > 0);
  if (!first) return [];
  return series.filter((entry) =>
    entry.points.length > 0 &&
    entry.unit === first.unit &&
    entry.xUnit === first.xUnit &&
    (entry.quantity === first.quantity ||
      isAnalyticFrequencyOverlayPair(first.quantity, entry.quantity))
  );
}

function isAnalyticFrequencyOverlayPair(
  firstQuantity: string,
  candidateQuantity: string,
): boolean {
  return (firstQuantity === "frequency" && candidateQuantity === "analytic_frequency") ||
    (firstQuantity === "analytic_frequency" && candidateQuantity === "frequency");
}

export function frequencyYAxisLabel(series: readonly FrequencyDomainChartSeries[]): string {
  const first = series[0];
  if (!first) return "response";
  if (series.every(isFrequencyValueSeries)) return first.unit ? `Frequency [${first.unit}]` : "Frequency";
  return first.unit ? `${first.label} [${first.unit}]` : first.label;
}

export function resolveFrequencyXAxisLabel(
  series: readonly FrequencyDomainChartSeries[],
  xLabel: string,
): string {
  if (xLabel.includes("[")) return xLabel;
  const unit = series.find((entry) => entry.xUnit)?.xUnit;
  return unit ? `${xLabel} [${unit}]` : xLabel;
}

function isFiniteFrequencyPoint(point: FrequencyDomainChartPoint): boolean {
  return Number.isInteger(point.rowIndex) &&
    point.rowIndex >= 0 &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y);
}
