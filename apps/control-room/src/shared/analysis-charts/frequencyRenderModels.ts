import type { ChartRenderModel } from "./chartRenderer";
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
  const envelope = spectralEnvelope(data);
  return {
    ariaLabel: "FMR / eigen modal spectrum",
    key: `frequency-spectrum:${frequencyUnit}:${data.length}:${data.at(-1)?.rowIndex ?? -1}`,
    provenance: {
      dataRevision: null,
      decimation: "none",
      query: `frequencyUnit=${frequencyUnit}`,
      resourceKey: "analysis/frequency-domain/eigen/spectrum",
    },
    series: [
      ...(envelope.length > 0 ? [{
        id: "spectral-envelope",
        kind: "line" as const,
        label: "Spectral envelope",
        points: envelope,
        unit: "a.u.",
        yAxis: 0,
      }] : []),
      {
        id: "modes",
        kind: "scatter" as const,
        label: "Modes",
        points: data.map((point) => ({ rowIndex: point.rowIndex, x: point.frequencyValue, y: 1 })),
        unit: "a.u.",
        yAxis: 0,
      },
    ],
    status: data.length > 0 ? "ready" : "empty",
    xAxis: { label: `frequency [${frequencyUnit}]`, unit: frequencyUnit },
    yAxes: [{ label: "intensity [a.u.]", unit: "a.u." }],
  };
}

function spectralEnvelope(
  data: readonly { dampingRateHz?: number | null; frequencyValue: number }[],
): { rowIndex: number; x: number; y: number }[] {
  const damped = data.filter((point) =>
    point.dampingRateHz != null && Number.isFinite(point.dampingRateHz) && point.dampingRateHz > 0
  );
  if (damped.length === 0) return [];
  const frequencies = data.map((point) => point.frequencyValue);
  const fMin = Math.min(...frequencies);
  const fMax = Math.max(...frequencies);
  const fRange = fMax - fMin || fMax * 0.1 || 1;
  const fStart = fMin - fRange * 0.15;
  const step = (fRange * 1.3) / 500;
  const points = Array.from({ length: 501 }, (_, rowIndex) => {
    const x = fStart + step * rowIndex;
    const y = damped.reduce((sum, point) => {
      const halfGamma = point.dampingRateHz! / 2;
      return sum + 1 / ((x - point.frequencyValue) ** 2 + halfGamma ** 2);
    }, 0);
    return { rowIndex, x, y };
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
      kind: "line",
      label: entry.label,
      points: entry.points,
      unit: entry.unit,
      yAxis: 0,
    })),
    status: compatible.some((entry) => entry.points.length > 0) ? "ready" : "empty",
    xAxis: { label: resolveFrequencyXAxisLabel(compatible, xLabel), unit: xUnit },
    yAxes: [{ label: frequencyYAxisLabel(compatible), unit: yUnit }],
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
    entry.quantity === first.quantity &&
    entry.unit === first.unit &&
    entry.xUnit === first.xUnit
  );
}

export function frequencyYAxisLabel(series: readonly FrequencyDomainChartSeries[]): string {
  const first = series[0];
  if (!first) return "response";
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
