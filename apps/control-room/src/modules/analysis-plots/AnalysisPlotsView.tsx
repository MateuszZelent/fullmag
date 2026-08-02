"use client";

import { useMemo } from "react";

import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";

import { buildScalarChartSeries, type TableRowsLike } from "./chartTableModel";
import { AnalysisEnergySurface } from "./components/AnalysisEnergySurface";
import { AnalysisFrequencySurface } from "./components/AnalysisFrequencySurface";
import { AnalysisSurfaceTabs } from "./components/AnalysisSurfaceTabs";
import { AnalysisTableSurface } from "./components/AnalysisTableSurface";
import {
  filterSeriesForSurface,
  formatTableSummary,
  formatXAxisLabel,
  resourceStatusFromString,
  surfaceTitle,
  tableRowsLike,
  tableWindowTableId,
} from "./analysisWorkbenchModel";
import type { AnalysisPlotsViewProps } from "./analysisPlotsViewTypes";
export function AnalysisPlotsView({
  activeSurface = "overview",
  frequencyDomainSeries = [],
  frequencyDomainStatus = "idle",
  frequencyDomainTitle = "Frequency-domain analysis",
  frequencyDomainUnavailableReason = null,
  kernel,
  liveMode = "following",
  onPointSelect,
  onRangeChange,
  onSurfaceChange = () => {},
  onSelectedSeriesIdsChange = () => undefined,
  range,
  selectedPoint,
  selectedStageId,
  solverEnergySeries,
  solverEnergyStatus,
  tableRowsStatus,
  tableRowsRefresh,
  tableRowsUnsupportedReason = null,
  visibleTable,
  xAxisId,
  selectedSeriesIds,
}: AnalysisPlotsViewProps) {
  const tableSurfaceActive =
    activeSurface === "overview" ||
    activeSurface === "dynamics" ||
    activeSurface === "convergence";
  const table = useMemo<TableRowsLike | null>(() => tableRowsLike(visibleTable), [visibleTable]);
  const chartSeries = useMemo(
    () =>
      table && tableSurfaceActive
        ? filterSeriesForSurface(
            buildScalarChartSeries(table, {
              dataRevision: visibleTable?.revision ?? null,
              status: resourceStatusFromString(tableRowsStatus),
              tableId: tableWindowTableId(visibleTable),
              xAxisId,
              yAxisIds: table.columns
                .filter((column) => column.column_id !== xAxisId)
                .map((column) => column.column_id),
            }),
            activeSurface,
          )
        : [],
    [activeSurface, table, tableRowsStatus, tableSurfaceActive, visibleTable, xAxisId],
  );
  const showFrequency =
    activeSurface === "frequency" ||
    (activeSurface === "overview" &&
      (frequencyDomainSeries.length > 0 || frequencyDomainStatus === "loading" || frequencyDomainStatus === "error" || frequencyDomainStatus === "ready"));
  return (
    <div className="fm-analysis-plots">
      {!selectedStageId ? (
        <AnalysisSurfaceTabs active={activeSurface} onChange={onSurfaceChange} />
      ) : null}
      <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
        <header className="fm-analysis-plots__header">
          <h3>{selectedStageId ? "Hysteresis Plot" : surfaceTitle(activeSurface)}</h3>
          <span>{selectedStageId ? "Hysteresis loop points & branches" : formatTableSummary(visibleTable, tableRowsStatus)}</span>
        </header>
        {selectedStageId ? <HysteresisChart kernel={kernel} stageId={selectedStageId} /> : null}
        {!selectedStageId && tableSurfaceActive ? (
          <AnalysisTableSurface
            chartSeries={chartSeries}
            kernel={kernel}
            liveMode={liveMode}
            onPointSelect={onPointSelect}
            onRangeChange={onRangeChange}
            onSelectedSeriesIdsChange={(nextSelectedSeriesIds) =>
              onSelectedSeriesIdsChange("table", nextSelectedSeriesIds)}
            range={range}
            selectedSeriesIds={selectedSeriesIds}
            selectedPoint={selectedPoint}
            status={tableRowsStatus}
            tableRowsRefresh={tableRowsRefresh}
            unsupportedReason={tableRowsUnsupportedReason}
            table={visibleTable}
            xAxisId={xAxisId}
            xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)}
          />
        ) : null}
        {!selectedStageId && activeSurface === "energy" ? (
          <AnalysisEnergySurface
            kernel={kernel}
            onPointSelect={onPointSelect}
            onSelectedSeriesIdsChange={(nextSelectedSeriesIds) =>
              onSelectedSeriesIdsChange("energy", nextSelectedSeriesIds)}
            selectedSeriesIds={selectedSeriesIds}
            series={solverEnergySeries}
            status={solverEnergyStatus}
          />
        ) : null}
        {!selectedStageId && showFrequency ? (
          <AnalysisFrequencySurface
            kernel={kernel}
            onPointSelect={onPointSelect}
            onSelectedSeriesIdsChange={(nextSelectedSeriesIds) =>
              onSelectedSeriesIdsChange("frequency", nextSelectedSeriesIds)}
            selectedSeriesIds={selectedSeriesIds}
            selectedPoint={selectedPoint}
            series={frequencyDomainSeries}
            status={frequencyDomainStatus}
            title={frequencyDomainTitle}
            unavailableReason={frequencyDomainUnavailableReason}
          />
        ) : null}
      </section>
    </div>
  );
}
