"use client";

import { useMemo } from "react";

import type { TableRowsResource } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";

import {
  buildScalarChartSeries,
  type ChartSeries,
  type ChartValueRange,
  type TableRowsLike,
} from "./chartTableModel";
import { EChartsSurface } from "./components/EChartsSurface";
import { frequencyDomainXAxisLabel } from "./frequencyDomainSeriesAdapter";

const EMPTY_CHART_SERIES: readonly ChartSeries[] = [];

export function AnalysisPlotsView(
  props: Parameters<typeof useAnalysisPlotsView>[0],
) {
  return useAnalysisPlotsView(props);
}

function useAnalysisPlotsView({
  kernel,
  frequencyDomainSeries = EMPTY_CHART_SERIES,
  frequencyDomainStatus = "idle",
  frequencyDomainTitle = "Frequency-domain analysis",
  frequencyDomainUnavailableReason = null,
  selectedStageId,
  onClearRange,
  onPointSelect,
  onRangeChange,
  onSeriesSelect,
  range,
  selectedPoint,
  solverEnergySeries,
  solverEnergyStatus,
  tableRowsStatus,
  visibleTable,
  xAxisId,
  yAxisIds,
}: {
  kernel: KernelApi;
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  selectedStageId?: string | null;
  onClearRange: () => void;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange: (range: ChartValueRange) => void;
  onSeriesSelect: (series: ChartSeries) => void;
  range: ChartValueRange | null;
  selectedPoint: AnalysisChartCursorPoint | null;
  solverEnergySeries: readonly ChartSeries[];
  solverEnergyStatus: string;
  tableRowsStatus: string;
  visibleTable: TableRowsResource | null;
  xAxisId: string;
  yAxisIds: string[];
}) {
  const table = useMemo<TableRowsLike | null>(
    () =>
      visibleTable
        ? {
            columns: visibleTable.columns,
            rows: visibleTable.rows,
          }
        : null,
    [visibleTable],
  );
  const chartSeries = useMemo(
    () =>
      table
        ? buildScalarChartSeries(table, {
            status: resourceStatusFromString(tableRowsStatus),
            tableId: visibleTable?.table_id ?? "default",
            xAxisId,
            yAxisIds,
          })
        : [],
    [table, tableRowsStatus, visibleTable?.table_id, xAxisId, yAxisIds],
  );
  const activeYSeriesCount = chartSeries.length;
  const seriesLegend = buildSeriesLegend(chartSeries);
  const energyLegend = buildSeriesLegend(solverEnergySeries);
  const frequencyDomainLegend = buildSeriesLegend(frequencyDomainSeries);
  const frequencyDomainWorkflow = useMemo(
    () => buildFrequencyDomainWorkflowSummary(frequencyDomainTitle),
    [frequencyDomainTitle],
  );
  const frequencyDomainWorkbench = useMemo(
    () =>
      buildFrequencyDomainWorkbenchSummary(
        frequencyDomainSeries,
        frequencyDomainTitle,
        frequencyDomainStatus,
      ),
    [frequencyDomainSeries, frequencyDomainStatus, frequencyDomainTitle],
  );
  const selectedFrequencyDomainPoint = useMemo(
    () => buildFrequencyDomainCursorSummary(selectedPoint, frequencyDomainTitle),
    [frequencyDomainTitle, selectedPoint],
  );
  const xAxisLabel = formatXAxisLabel(chartSeries, xAxisId);
  const showFrequencyDomainPanel =
    !selectedStageId &&
    (frequencyDomainSeries.length > 0 ||
      frequencyDomainStatus === "loading" ||
      frequencyDomainStatus === "error");

  return (
    <div className="fm-analysis-plots">
      <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
        <header className="fm-analysis-plots__header">
          <h3>{selectedStageId ? "Hysteresis Plot" : "Table charts"}</h3>
          <span>
            {selectedStageId
              ? "Hysteresis loop points & branches"
              : formatTableSummary(visibleTable, tableRowsStatus)}
          </span>
        </header>
        {!selectedStageId && (
          <div className="fm-analysis-plots__status" aria-label="Chart status">
            <StatusPill label="X" value={xAxisId} />
            <StatusPill
              label="Y"
              value={formatSeriesCount(activeYSeriesCount)}
            />
            <StatusPill
              label="Visible"
              value={visibleTable ? String(visibleTable.rows.length) : "0"}
            />
            <StatusPill
              label="Total"
              value={visibleTable ? String(visibleTable.total_rows) : "-"}
            />
            <StatusPill
              label="Zoom"
              value={range ? formatRange(range) : "off"}
            />
            <StatusPill
              label="Cursor"
              value={selectedPoint ? formatCursorPoint(selectedPoint) : "-"}
            />
          </div>
        )}
        {selectedStageId ? (
          <HysteresisChart kernel={kernel} stageId={selectedStageId} />
        ) : (
          <>
            {seriesLegend.length > 0 ? (
              <div className="fm-analysis-plots__legend" aria-label="Series legend">
                {seriesLegend.map((series, index) => (
                  <Button
                    aria-label={`Series ${series.label} unit ${series.unit} latest ${series.latest}`}
                    className="fm-analysis-plots__legend-item"
                    key={series.columnId}
                    onClick={() => onSeriesSelect(series.series)}
                    size="sm"
                    title={`${series.label} [${series.unit}] latest ${series.latest} from ${series.source}`}
                    type="button"
                    variant="secondary"
                  >
                    <span
                      aria-hidden="true"
                      className={`fm-analysis-plots__legend-swatch fm-analysis-plots__legend-swatch--${index % 5}`}
                    />
                    <span className="fm-analysis-plots__legend-label">
                      {series.label}
                    </span>
                    <span className="fm-analysis-plots__legend-unit">
                      {series.unit}
                    </span>
                    <span className="fm-analysis-plots__legend-latest">
                      {series.latest}
                    </span>
                  </Button>
                ))}
              </div>
            ) : null}
            <EChartsSurface
              dataStatus={tableRowsStatus}
              onPointSelect={onPointSelect}
              onRangeChange={onRangeChange}
              series={chartSeries}
              xAxisLabel={xAxisLabel}
            />
            <footer className="fm-analysis-plots__range">
              <span>
                {range
                  ? `zoom ${formatRangeValue(range.fromValue)}-${formatRangeValue(range.toValue)}`
                  : visibleTable
                    ? `cursor ${visibleTable.cursor_end}`
                    : "cursor -"}
              </span>
              <span>{visibleTable ? `${visibleTable.rows.length} visible` : "0 visible"}</span>
              {range ? (
                <Button
                  className="fm-analysis-plots__range-clear"
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={onClearRange}
                >
                  Clear zoom
                </Button>
              ) : null}
            </footer>
          </>
        )}
        {!selectedStageId && solverEnergySeries.length > 0 ? (
          <div className="fm-analysis-plots__subchart fm-analysis-plots__subchart--energy">
            <header className="fm-analysis-plots__subchart-header">
              <h4>Energy history</h4>
              <span>{`${formatSeriesCount(solverEnergySeries.length)} / time [s]`}</span>
            </header>
            <div
              className="fm-analysis-plots__legend"
              aria-label="Energy series legend"
            >
              {energyLegend.map((series, index) => (
                <Button
                  aria-label={`Series ${series.label} unit ${series.unit} latest ${series.latest}`}
                  className="fm-analysis-plots__legend-item"
                  key={series.columnId}
                  onClick={() => onSeriesSelect(series.series)}
                  size="sm"
                  title={`${series.label} [${series.unit}] latest ${series.latest} from ${series.source}`}
                  type="button"
                  variant="secondary"
                >
                  <span
                    aria-hidden="true"
                    className={`fm-analysis-plots__legend-swatch fm-analysis-plots__legend-swatch--${index % 5}`}
                  />
                  <span className="fm-analysis-plots__legend-label">
                    {series.label}
                  </span>
                  <span className="fm-analysis-plots__legend-unit">
                    {series.unit}
                  </span>
                  <span className="fm-analysis-plots__legend-latest">
                    {series.latest}
                  </span>
                </Button>
              ))}
            </div>
            <EChartsSurface
              dataStatus={solverEnergyStatus}
              onPointSelect={onPointSelect}
              series={solverEnergySeries}
              xAxisLabel="time [s]"
            />
          </div>
        ) : null}
        {showFrequencyDomainPanel ? (
          <div className="fm-analysis-plots__subchart fm-analysis-plots__subchart--frequency-domain">
            <header className="fm-analysis-plots__subchart-header">
              <h4>{frequencyDomainTitle}</h4>
              <span>
                {frequencyDomainSeries.length > 0
                  ? formatSeriesCount(frequencyDomainSeries.length)
                  : frequencyDomainStatus}
              </span>
            </header>
            {frequencyDomainSeries.length > 0 ? (
              <>
                {frequencyDomainWorkflow ? (
                  <div
                    aria-label="Frequency-domain workflow"
                    className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-workflow"
                  >
                    <StatusPill
                      label="Workflow"
                      value={frequencyDomainWorkflow.workflow}
                    />
                    <StatusPill
                      label="Next"
                      value={frequencyDomainWorkflow.next}
                    />
                    <StatusPill
                      label="Artifacts"
                      value={frequencyDomainWorkflow.artifacts}
                    />
                    <StatusPill
                      label="Inspector"
                      value={frequencyDomainWorkflow.inspector}
                    />
                  </div>
                ) : null}
                <div
                  aria-label="Frequency-domain workbench"
                  className="fm-analysis-plots__workbench"
                >
                  <StatusPill
                    label="Chart"
                    value={frequencyDomainWorkbench.chartKind}
                  />
                  <StatusPill
                    label="Points"
                    value={frequencyDomainWorkbench.pointCount}
                  />
                  <StatusPill
                    label="Frequency"
                    value={frequencyDomainWorkbench.frequencyRange}
                  />
                  <StatusPill
                    label="3D handoff"
                    value={frequencyDomainWorkbench.fieldHandoff}
                  />
                  <StatusPill
                    label="Status"
                    value={frequencyDomainWorkbench.status}
                  />
                </div>
                <div
                  className="fm-analysis-plots__legend"
                  aria-label="Frequency-domain series legend"
                >
                  {frequencyDomainLegend.map((series, index) => (
                    <Button
                      aria-label={`Series ${series.label} unit ${series.unit} latest ${series.latest}`}
                      className="fm-analysis-plots__legend-item"
                      key={series.columnId}
                      onClick={() => onSeriesSelect(series.series)}
                      size="sm"
                      title={`${series.label} [${series.unit}] latest ${series.latest} from ${series.source}`}
                      type="button"
                      variant="secondary"
                    >
                      <span
                        aria-hidden="true"
                        className={`fm-analysis-plots__legend-swatch fm-analysis-plots__legend-swatch--${index % 5}`}
                      />
                      <span className="fm-analysis-plots__legend-label">
                        {series.label}
                      </span>
                      <span className="fm-analysis-plots__legend-unit">
                        {series.unit}
                      </span>
                      <span className="fm-analysis-plots__legend-latest">
                        {series.latest}
                      </span>
                    </Button>
                  ))}
                </div>
                <EChartsSurface
                  dataStatus={frequencyDomainStatus}
                  onPointSelect={onPointSelect}
                  series={frequencyDomainSeries}
                  xAxisLabel={frequencyDomainXAxisLabel(frequencyDomainSeries)}
                />
                {selectedFrequencyDomainPoint ? (
                  <div
                    aria-label="Selected frequency-domain point"
                    className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-selection"
                  >
                    <StatusPill
                      label="Selected"
                      value={selectedFrequencyDomainPoint.title}
                    />
                    <StatusPill
                      label={selectedFrequencyDomainPoint.xLabel}
                      value={selectedFrequencyDomainPoint.xValue}
                    />
                    <StatusPill
                      label={selectedFrequencyDomainPoint.yLabel}
                      value={selectedFrequencyDomainPoint.yValue}
                    />
                    <StatusPill
                      label="Inspector"
                      value={selectedFrequencyDomainPoint.inspectorTarget}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="fm-analysis-plots__empty" role="status">
                {frequencyDomainUnavailableReason ??
                  formatFrequencyDomainEmptyState(frequencyDomainStatus)}
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <span
      aria-label={`${label} ${value}`}
      className="fm-analysis-plots__status-pill"
      title={`${label} ${value}`}
    >
      <span className="fm-analysis-plots__status-label">{label}</span>
      <span className="fm-analysis-plots__status-value">{value}</span>
    </span>
  );
}

function formatTableSummary(
  table: TableRowsResource | null,
  status: string,
): string {
  if (!table) return status;
  return `${table.total_rows} rows / ${table.columns.length} columns`;
}

function formatRangeValue(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatRange(range: ChartValueRange): string {
  return `${formatRangeValue(range.fromValue)}-${formatRangeValue(range.toValue)}`;
}

function formatSeriesCount(count: number): string {
  return `${count} series`;
}

function formatCursorPoint(point: AnalysisChartCursorPoint): string {
  return `${point.label} ${formatLatestValue(point.point.y)}`;
}

function buildSeriesLegend(
  chartSeries: readonly ChartSeries[],
) {
  return chartSeries.map((series) => ({
    columnId: series.id,
    label: series.label || series.quantity,
    latest: formatLatestValue(series.points.at(-1)?.y),
    series,
    source: series.source.resourceKey,
    unit: series.unit || "1",
  }));
}

function formatXAxisLabel(chartSeries: readonly ChartSeries[], xAxisId: string): string {
  const unit = chartSeries.find((series) => series.xUnit)?.xUnit;
  return unit ? `${xAxisId} [${unit}]` : xAxisId;
}

function formatFrequencyDomainEmptyState(status: string): string {
  if (status === "loading") return "Loading frequency-domain artifacts";
  if (status === "error") return "Frequency-domain artifacts failed to load";
  if (status === "stale") return "Frequency-domain artifacts are missing or stale";
  return "No frequency-domain series available";
}

function buildFrequencyDomainWorkflowSummary(chartTitle: string): {
  artifacts: string;
  inspector: string;
  next: string;
  workflow: string;
} | null {
  const normalizedTitle = chartTitle.toLowerCase();
  if (normalizedTitle.startsWith("fmr modal")) {
    return {
      artifacts: "Mode fields",
      inspector: "mode inspector",
      next: "select mode to 3D overlay",
      workflow: "FMR modal",
    };
  }
  if (normalizedTitle.startsWith("fmr response")) {
    return {
      artifacts: "Response fields",
      inspector: "response point inspector",
      next: "select frequency to response overlay",
      workflow: "FMR driven",
    };
  }
  return null;
}

function buildFrequencyDomainWorkbenchSummary(
  series: readonly ChartSeries[],
  chartTitle: string,
  status: string,
): {
  chartKind: string;
  fieldHandoff: string;
  frequencyRange: string;
  pointCount: string;
  status: string;
} {
  const first = series.find((entry) => entry.points.length > 0) ?? series[0];
  const tableId = first?.source.tableId ?? "frequency-domain";
  const points = series.flatMap((entry) => entry.points);
  const finiteX: number[] = [];
  const finiteY: number[] = [];
  for (const point of points) {
    if (Number.isFinite(point.x)) finiteX.push(point.x);
    if (Number.isFinite(point.y)) finiteY.push(point.y);
  }
  const frequencyValues =
    tableId === "frequency-domain:response-sweep"
      ? finiteX
      : tableId === "frequency-domain:eigen-spectrum" ||
          tableId === "frequency-domain:eigen-dispersion"
        ? finiteY
        : [];
  return {
    chartKind: frequencyDomainChartKind(tableId, chartTitle),
    fieldHandoff: frequencyDomainFieldHandoff(tableId, chartTitle),
    frequencyRange: formatFrequencyDomainWorkbenchRange(frequencyValues, first),
    pointCount: `${points.length} point${points.length === 1 ? "" : "s"}`,
    status,
  };
}

function frequencyDomainChartKind(tableId: string, chartTitle: string): string {
  if (tableId === "frequency-domain:eigen-spectrum") {
    return chartTitle.toLowerCase().startsWith("fmr")
      ? "FMR modal spectrum"
      : "modal spectrum";
  }
  if (tableId === "frequency-domain:eigen-dispersion") return "dispersion";
  if (tableId === "frequency-domain:response-sweep") {
    return chartTitle.toLowerCase().startsWith("fmr")
      ? "FMR driven sweep"
      : "response sweep";
  }
  return "frequency-domain";
}

function frequencyDomainFieldHandoff(tableId: string, chartTitle: string): string {
  if (tableId === "frequency-domain:eigen-spectrum") {
    return chartTitle.toLowerCase().startsWith("fmr")
      ? "select mode -> FMR 3D overlay"
      : "select mode -> 3D overlay";
  }
  if (tableId === "frequency-domain:eigen-dispersion") {
    return "select branch point -> mode overlay";
  }
  if (tableId === "frequency-domain:response-sweep") {
    return chartTitle.toLowerCase().startsWith("fmr")
      ? "select frequency -> FMR response overlay"
      : "select frequency -> response overlay";
  }
  return "select point -> inspector";
}

function formatFrequencyDomainWorkbenchRange(
  values: readonly number[],
  firstSeries: ChartSeries | undefined,
): string {
  if (!values.length) return "not available";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const unit = firstSeries?.source.tableId === "frequency-domain:response-sweep"
    ? firstSeries.xUnit
    : firstSeries?.unit;
  if (min === max) return formatPointValue(min, unit);
  return `${formatPointValue(min, unit)}-${formatPointValue(max, unit)}`;
}

function buildFrequencyDomainCursorSummary(
  point: AnalysisChartCursorPoint | null,
  chartTitle: string,
): {
  inspectorTarget: string;
  title: string;
  xLabel: string;
  xValue: string;
  yLabel: string;
  yValue: string;
} | null {
  if (!point || point.source.kind !== "analysis.frequency_domain") return null;
  const xValue = formatPointValue(point.point.x, point.xUnit);
  const yValue = formatPointValue(point.point.y, point.unit);
  switch (point.source.tableId) {
    case "frequency-domain:eigen-spectrum":
      if (chartTitle.toLowerCase().startsWith("fmr")) {
        return {
          inspectorTarget: "FMR mode inspector and 3D overlay controls",
          title: "FMR mode",
          xLabel: "mode",
          xValue,
          yLabel: point.quantity || "frequency",
          yValue,
        };
      }
      return {
        inspectorTarget: "Mode inspector and 3D mode controls",
        title: "eigen mode",
        xLabel: "mode",
        xValue,
        yLabel: point.quantity || "frequency",
        yValue,
      };
    case "frequency-domain:eigen-dispersion":
      return {
        inspectorTarget: "Dispersion inspector",
        title: "dispersion point",
        xLabel: "path_s",
        xValue,
        yLabel: point.quantity || "frequency",
        yValue,
      };
    case "frequency-domain:response-sweep":
      if (chartTitle.toLowerCase().startsWith("fmr")) {
        return {
          inspectorTarget: "FMR response point inspector and 3D response overlay",
          title: "FMR response point",
          xLabel: "frequency",
          xValue,
          yLabel: point.quantity || "response",
          yValue,
        };
      }
      return {
        inspectorTarget: "Response point inspector and 3D response controls",
        title: "response point",
        xLabel: "frequency",
        xValue,
        yLabel: point.quantity || "response",
        yValue,
      };
    default:
      return {
        inspectorTarget: "Frequency-domain inspector",
        title: "frequency-domain point",
        xLabel: "x",
        xValue,
        yLabel: point.quantity || "value",
        yValue,
      };
  }
}

function resourceStatusFromString(status: string): ResourceStatus {
  switch (status) {
    case "idle":
    case "loading":
    case "ready":
    case "stale":
    case "error":
      return status;
    default:
      return "idle";
  }
}

function formatPointValue(value: number, unit: string | undefined): string {
  const formatted = formatLatestValue(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatLatestValue(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  const precise = value.toPrecision(5);
  return precise.includes("e") ? precise : String(Number(precise));
}
