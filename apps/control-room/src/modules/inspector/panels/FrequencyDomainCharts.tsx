"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";

import { EChartsCanvasSurface } from "@/shared/analysis-charts/EChartsCanvasSurface";
import { ChartExportControls } from "@/shared/analysis-charts/ChartExportControls";
import type { ChartRendererOwner, ChartRenderModel } from "@/shared/analysis-charts/chartRenderer";
import {
  frequencySeriesRenderModel,
  frequencySpectrumRenderModel,
} from "@/shared/analysis-charts/frequencyRenderModels";

import type {
  EigenDispersionPoint,
  EigenSpectrumPoint,
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(5)).toLocaleString("en-US");
}

export function FrequencyDomainSpectrumChart({
  model,
  onPlotMode,
  onSelectMode,
  selectedModeKey,
}: {
  model: FrequencyDomainChartBuildResult<EigenSpectrumPoint>;
  onPlotMode?: (point: EigenSpectrumPoint) => void;
  onSelectMode?: (point: EigenSpectrumPoint) => void;
  selectedModeKey?: string | null;
}) {
  const frequencySeries = model.series.find(
    (series) => series.quantity === "frequency",
  );
  const frequencyUnit = frequencySeries?.unit ?? "Hz";
  const data = model.points.map((point, rowIndex) => {
    const frequencySeriesPoint = frequencySeries?.points.find(
      (seriesPoint) => seriesPoint.rowIndex === rowIndex,
    );
    const frequencyValue = frequencySeriesPoint?.y ?? point.frequencyHz;
    const frequencyScale =
      point.frequencyHz !== 0 && frequencySeriesPoint?.y != null
        ? frequencySeriesPoint.y / point.frequencyHz
        : 1;
    return {
      dampingRateHz:
        point.dampingRateHz == null
          ? null
          : point.dampingRateHz * frequencyScale,
      dampingRateLabel:
        point.dampingRateHz == null
          ? null
          : formatFrequencyHz(point.dampingRateHz),
      frequencyLabel: `${formatNumber(frequencyValue)} ${frequencyUnit}`,
      frequencyValue,
      hasField: Boolean(point.modeFieldId),
      leakage: point.tangentLeakageMax,
      mode: point.rawModeIndex,
      name: `mode ${point.rawModeIndex}`,
      rowIndex,
      residualNorm: point.residualNorm,
      sample: point.sampleIndex,
      selected:
        selectedModeKey === `${point.sampleIndex}:${point.rawModeIndex}`,
    };
  });
  const resolvePoint = (event: unknown) => {
    const rowIndex = spectrumPointIndexFromChartEvent(event);
    return rowIndex == null ? null : model.points[rowIndex] ?? null;
  };

  return (
    <FrequencyDomainEChartsFrame
      droppedPointCount={model.droppedPointCount}
      onChartClick={(event) => {
        const point = resolvePoint(event);
        if (point) onSelectMode?.(point);
      }}
      model={frequencySpectrumRenderModel(data, frequencyUnit)}
      pointCount={data.length}
      title="FMR / eigen modal spectrum"
    >
      {data.map((point) => (
        <div className="fm-frequency-domain-chart__point-actions" key={`:`}>
        <Button
          aria-label={`Select mode ${point.mode} at ${point.frequencyLabel}, ${point.hasField ? "3D field available" : "3D field missing"}`}
          className="fm-frequency-domain-chart__mode"
          data-selected={point.selected ? "true" : undefined}
          size="sm"
          type="button"
          variant={point.selected ? "primary" : "secondary"}
          onClick={() => onSelectMode?.(model.points[point.rowIndex]!)}
        >
          <Eye aria-hidden="true" size={13} />
          <span>
            mode {point.mode}: {point.frequencyLabel}
          </span>
          <small>
            {point.hasField ? "3D ready" : "field missing"}
            {point.residualNorm != null
              ? ` | residual ${formatNumber(point.residualNorm)}`
              : ""}
            {point.dampingRateHz != null
              ? ` | damping ${point.dampingRateLabel}`
              : ""}
            {point.leakage != null
              ? ` | leakage ${formatNumber(point.leakage)}`
              : ""}
          </small>
        </Button>
        <Button
          aria-label={`Load mode ${point.mode} in 3D`}
          className="fm-frequency-domain-chart__mode"
          disabled={!point.hasField}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onPlotMode?.(model.points[point.rowIndex]!)}
        >
          Load in 3D
        </Button>
        </div>
      ))}
    </FrequencyDomainEChartsFrame>
  );
}

export function FrequencyDomainDispersionChart({
  model,
  onSelectPoint,
}: {
  model: FrequencyDomainChartBuildResult<EigenDispersionPoint>;
  onSelectPoint?: (point: EigenDispersionPoint) => void;
}) {
  const resolvePoint = (event: unknown) => {
    const rowIndex = frequencyDomainSeriesPointIndexFromChartEvent(event);
    return rowIndex == null ? null : model.points[rowIndex] ?? null;
  };

  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      onChartClick={(event) => {
        const point = resolvePoint(event);
        if (point) onSelectPoint?.(point);
      }}
      series={model.series}
      title="Bloch / Floquet dispersion"
      xLabel="k-path s [rad/m]"
    >
      {model.points.slice(0, 4).map((point) => {
        const pointLabel = dispersionPointLabel(point);
        return (
          <Button
            aria-label={`Select dispersion ${pointLabel}`}
            className="fm-frequency-domain-chart__mode"
            key={`${point.sampleIndex}:${point.rawModeIndex}:${point.pathS}`}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => onSelectPoint?.(point)}
          >
            <Eye aria-hidden="true" size={13} />
            <span>{pointLabel}</span>
            <small>
              {formatFrequencyHz(point.frequencyHz)}
              {point.branchId ? ` | branch ${point.branchId}` : ""}
              {point.linewidthHz != null
                ? ` | linewidth ${formatFrequencyHz(point.linewidthHz)}`
                : ""}
            </small>
          </Button>
        );
      })}
    </FrequencyDomainSeriesChart>
  );
}

function dispersionPointLabel(point: EigenDispersionPoint): string {
  const sample = `sample ${point.sampleIndex}`;
  const mode = `mode ${point.rawModeIndex}`;
  return point.sampleLabel
    ? `${point.sampleLabel} ${sample}, ${mode}`
    : `${sample}, ${mode}`;
}

export function FrequencyDomainResponseChart({
  model,
  onPlotPoint,
  onSelectPoint,
}: {
  model: FrequencyDomainChartBuildResult<FrequencyResponsePoint>;
  onPlotPoint?: (point: FrequencyResponsePoint) => void;
  onSelectPoint?: (point: FrequencyResponsePoint) => void;
}) {
  const observableOptions = useMemo(
    () => responseObservableOptions(model.points),
    [model.points],
  );
  const [selectedObservable, setSelectedObservable] = useState(
    () => observableOptions[0]?.value ?? "response",
  );
  const effectiveObservable =
    observableOptions.find((option) => option.value === selectedObservable)
      ?.value ??
    observableOptions[0]?.value ??
    "response";
  const quantityOptions = useMemo(
    () => responseQuantityOptions(model.series, model.points, effectiveObservable),
    [effectiveObservable, model.points, model.series],
  );
  const [selectedQuantity, setSelectedQuantity] = useState("amplitude");
  const effectiveQuantity =
    quantityOptions.find((option) => option.value === selectedQuantity)?.value ??
    quantityOptions[0]?.value ??
    "amplitude";
  const chartSeries = useMemo(
    () =>
      filterResponseChartSeries(
        model.series,
        model.points,
        effectiveObservable,
        effectiveQuantity,
      ),
    [effectiveObservable, effectiveQuantity, model.points, model.series],
  );
  const chartPoints = useMemo(
    () =>
      model.points.filter((point) => point.observableId === effectiveObservable),
    [effectiveObservable, model.points],
  );
  const resolvePoint = (event: unknown) => {
    const rowIndex = frequencyDomainSeriesPointIndexFromChartEvent(event);
    return rowIndex == null ? null : model.points[rowIndex] ?? null;
  };

  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      onChartClick={(event) => {
        const point = resolvePoint(event);
        if (point) onSelectPoint?.(point);
      }}
      onChartDoubleClick={(event) => {
        const point = resolvePoint(event);
        if (point) onPlotPoint?.(point);
      }}
      series={chartSeries}
      title="Driven FMR frequency response"
      xLabel="frequency"
    >
      <div className="fm-frequency-domain-chart__controls">
        <label className="fm-frequency-domain-chart__control">
          <span>Response component</span>
          <select
            aria-label="Response component"
            className="fm-inspector-select"
            value={effectiveObservable}
            onChange={(event) => setSelectedObservable(event.target.value)}
          >
            {observableOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fm-frequency-domain-chart__control">
          <span>Chart quantity</span>
          <select
            aria-label="Chart quantity"
            className="fm-inspector-select"
            value={effectiveQuantity}
            onChange={(event) => setSelectedQuantity(event.target.value)}
          >
            {quantityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} [{option.unit}]
              </option>
            ))}
          </select>
        </label>
      </div>
      {chartPoints.map((point, index) => {
        const pointIndex = point.frequencyIndex ?? index;
        const frequencyLabel = formatFrequencyHz(point.frequencyHz);
        return (
          <div
            className="fm-frequency-domain-chart__point-actions"
            key={`${point.observableId}:${pointIndex}:${point.frequencyHz}`}
          >
            <Button
              aria-label={`Select response point ${pointIndex} at ${frequencyLabel}`}
              className="fm-frequency-domain-chart__mode"
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onSelectPoint?.(point)}
            >
              <Eye aria-hidden="true" size={13} />
              <span>
                {point.observableId}: {frequencyLabel}
              </span>
              <small>{point.fieldId ? "field ready" : "field missing"}</small>
            </Button>
            <Button
              aria-label={`Load response field ${pointIndex} at ${frequencyLabel}`}
              className="fm-frequency-domain-chart__mode"
              disabled={!point.fieldId}
              size="sm"
              title={point.fieldId ? "Load response field in 3D" : "Response field missing"}
              type="button"
              variant="secondary"
              onClick={() => onPlotPoint?.(point)}
            >
              Load in 3D
            </Button>
          </div>
        );
      })}
    </FrequencyDomainSeriesChart>
  );
}

interface ResponseChartOption {
  label: string;
  unit?: string;
  value: string;
}

function responseObservableOptions(
  points: readonly FrequencyResponsePoint[],
): ResponseChartOption[] {
  const seen = new Set<string>();
  const options: ResponseChartOption[] = [];
  for (const point of points) {
    if (seen.has(point.observableId)) continue;
    seen.add(point.observableId);
    options.push({
      label: responseObservableLabel(point.observableId),
      value: point.observableId,
    });
  }
  return options.length > 0
    ? options.toSorted((left, right) =>
        responseObservableSortKey(left.value) - responseObservableSortKey(right.value) ||
        left.label.localeCompare(right.label),
      )
    : [{ label: "response", value: "response" }];
}

function responseQuantityOptions(
  series: readonly FrequencyDomainChartSeries[],
  points: readonly FrequencyResponsePoint[],
  observableId: string,
): ResponseChartOption[] {
  const rowIndices = new Set(
    points.flatMap((point, rowIndex) =>
      point.observableId === observableId ? [rowIndex] : [],
    ),
  );
  const options = series.flatMap((entry) =>
    entry.points.some((point) => rowIndices.has(point.rowIndex))
      ? [
          {
            label: entry.label,
            unit: entry.unit,
            value: entry.quantity,
          },
        ]
      : [],
  );
  return options.length > 0
    ? options
    : [{ label: "Amplitude", unit: "not published", value: "amplitude" }];
}

function filterResponseChartSeries(
  series: readonly FrequencyDomainChartSeries[],
  points: readonly FrequencyResponsePoint[],
  observableId: string,
  quantity: string,
): FrequencyDomainChartSeries[] {
  const rowIndices = new Set(
    points.flatMap((point, rowIndex) =>
      point.observableId === observableId ? [rowIndex] : [],
    ),
  );
  return series.flatMap((entry) => {
    if (entry.quantity !== quantity) return [];
    const filteredPoints = entry.points.filter((point) =>
      rowIndices.has(point.rowIndex),
    );
    return filteredPoints.length > 0 ? [{ ...entry, points: filteredPoints }] : [];
  });
}

function responseObservableLabel(value: string): string {
  switch (value) {
    case "mx":
    case "m_x":
      return "mx";
    case "my":
    case "m_y":
      return "my";
    case "mz":
    case "m_z":
      return "mz";
    case "magnitude":
    case "mag":
    case "|m|":
      return "|m|";
    default:
      return value;
  }
}

function responseObservableSortKey(value: string): number {
  switch (responseObservableLabel(value)) {
    case "mx":
      return 0;
    case "my":
      return 1;
    case "mz":
      return 2;
    case "|m|":
      return 3;
    default:
      return 10;
  }
}

function FrequencyDomainSeriesChart({
  children,
  droppedPointCount,
  onChartClick,
  onChartDoubleClick,
  series,
  title,
  xLabel,
}: {
  children?: ReactNode;
  droppedPointCount: number;
  onChartClick?: (event: unknown) => void;
  onChartDoubleClick?: (event: unknown) => void;
  series: readonly FrequencyDomainChartSeries[];
  title: string;
  xLabel: string;
}) {
  const chartSeries = series.filter((entry) => entry.points.length > 0);
  const pointCount = chartSeries.reduce(
    (count, entry) => count + entry.points.length,
    0,
  );

  return (
    <FrequencyDomainEChartsFrame
      droppedPointCount={droppedPointCount}
      onChartClick={onChartClick}
      onChartDoubleClick={onChartDoubleClick}
      model={frequencySeriesRenderModel(chartSeries, title, xLabel)}
      pointCount={pointCount}
      title={title}
    >
      {chartSeries.slice(0, 4).map((entry) => (
        <span key={entry.id}>
          {entry.label}: {entry.points.length} samples
        </span>
      ))}
      {children}
    </FrequencyDomainEChartsFrame>
  );
}

function FrequencyDomainEChartsFrame({
  children, droppedPointCount, model, onChartClick, onChartDoubleClick, pointCount, title,
}: {
  children: ReactNode;
  droppedPointCount: number;
  model: ChartRenderModel;
  onChartClick?: (event: unknown) => void;
  onChartDoubleClick?: (event: unknown) => void;
  pointCount: number;
  title: string;
}) {
  const exportRef = useRef<ChartRendererOwner | null>(null);
  return (
    <div aria-label={title} className="fm-frequency-domain-chart" data-renderer="echarts">
      <div className="fm-frequency-domain-chart__header">
        <span>{title}</span>
        <small>
          ECharts, {pointCount} points
          {droppedPointCount > 0 ? `, ${droppedPointCount} dropped` : ""}
        </small>
      </div>
      {pointCount > 0 ? (
        <EChartsCanvasSurface
          className="fm-frequency-domain-chart__canvas"
          exportRef={exportRef}
          model={model}
          onClick={onChartClick}
          onDoubleClick={onChartDoubleClick}
        >
          <div className="fm-frequency-domain-chart__summary">{children}</div>
        </EChartsCanvasSurface>
      ) : (
        <div className="fm-frequency-domain-chart__empty">No chartable frequency-domain samples.</div>
      )}
      <ChartExportControls model={model} rendererRef={exportRef} />
    </div>
  );
}

export function spectrumPointIndexFromChartEvent(event: unknown): number | null {
  const data =
    event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : null;
  if (!Array.isArray(data)) return null;
  const rowIndex = data[2];
  return typeof rowIndex === "number" && Number.isInteger(rowIndex)
    ? rowIndex
    : null;
}

export function frequencyDomainSeriesPointIndexFromChartEvent(
  event: unknown,
): number | null {
  const data =
    event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : null;
  const value =
    data && typeof data === "object" && !Array.isArray(data) && "value" in data
      ? (data as { value?: unknown }).value
      : data;
  if (!Array.isArray(value)) return null;
  const rowIndex = value[2];
  return typeof rowIndex === "number" && Number.isInteger(rowIndex)
    ? rowIndex
    : null;
}
