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
  hiddenSeriesIds,
  kernel,
  liveMode = "following",
  onPointSelect,
  onRangeChange,
  onSolo,
  onSurfaceChange = () => {},
  onToggleVisibility,
  range,
  selectedPoint,
  selectedStageId,
  solverEnergySeries,
  solverEnergyStatus,
  tableRowsStatus,
  visibleTable,
  xAxisId,
  yAxisIds,
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
              yAxisIds,
            }),
            activeSurface,
          )
        : [],
    [activeSurface, table, tableRowsStatus, tableSurfaceActive, visibleTable, xAxisId, yAxisIds],
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
            hiddenSeriesIds={hiddenSeriesIds}
            kernel={kernel}
            liveMode={liveMode}
            onPointSelect={onPointSelect}
            onRangeChange={onRangeChange}
            onToggleVisibility={onToggleVisibility}
            range={range}
            selectedPoint={selectedPoint}
            status={tableRowsStatus}
            table={visibleTable}
            xAxisId={xAxisId}
            xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)}
          />
        ) : null}
        {!selectedStageId && activeSurface === "energy" ? (
          <AnalysisEnergySurface
            hiddenSeriesIds={hiddenSeriesIds}
            kernel={kernel}
            onPointSelect={onPointSelect}
            onSolo={onSolo}
            onToggleVisibility={onToggleVisibility}
            series={solverEnergySeries}
            status={solverEnergyStatus}
          />
        ) : null}
        {!selectedStageId && showFrequency ? (
          <AnalysisFrequencySurface
            hiddenSeriesIds={hiddenSeriesIds}
            kernel={kernel}
            onPointSelect={onPointSelect}
            onSolo={onSolo}
            onToggleVisibility={onToggleVisibility}
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
