"use client";

import { useMemo } from "react";

import type { TableRowsResource } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

import {
  buildScalarChartSeries,
  type ChartSeries,
  type ChartValueRange,
  type TableRowsLike,
} from "./chartTableModel";
import { EChartsSurface } from "./components/EChartsSurface";

export function AnalysisPlotsView({
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
  const xAxisLabel = formatXAxisLabel(chartSeries, xAxisId);

  return (
    <div className="fm-analysis-plots">
      <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
        <header className="fm-analysis-plots__header">
          <h3>Table charts</h3>
          <span>{formatTableSummary(visibleTable, tableRowsStatus)}</span>
        </header>
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
        {seriesLegend.length > 0 ? (
          <div className="fm-analysis-plots__legend" aria-label="Series legend">
            {seriesLegend.map((series, index) => (
              <button
                aria-label={`Series ${series.label} unit ${series.unit} latest ${series.latest}`}
                className="fm-analysis-plots__legend-item"
                key={series.columnId}
                onClick={() => onSeriesSelect(series.series)}
                title={`${series.label} [${series.unit}] latest ${series.latest} from ${series.source}`}
                type="button"
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
              </button>
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
            <button
              className="fm-analysis-plots__range-clear"
              type="button"
              onClick={onClearRange}
            >
              Clear zoom
            </button>
          ) : null}
        </footer>
        {solverEnergySeries.length > 0 ? (
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
                <button
                  aria-label={`Series ${series.label} unit ${series.unit} latest ${series.latest}`}
                  className="fm-analysis-plots__legend-item"
                  key={series.columnId}
                  onClick={() => onSeriesSelect(series.series)}
                  title={`${series.label} [${series.unit}] latest ${series.latest} from ${series.source}`}
                  type="button"
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
                </button>
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

function formatLatestValue(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  const precise = value.toPrecision(5);
  return precise.includes("e") ? precise : String(Number(precise));
}
