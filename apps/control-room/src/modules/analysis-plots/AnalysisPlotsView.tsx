"use client";

import { useMemo } from "react";

import type { DynamicStructureFactorResource, SpinWaveGammaResource } from "@/kernel/api/apiTypes";
import type { KernelApi } from "@/kernel/types";
import type { AnalysisWorkbenchSurface } from "@/kernel/workspace/analysisPlotsWorkspace";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";

import { buildScalarChartSeries, type ChartSeries, type ChartValueRange, type TableRowsLike } from "./chartTableModel";
import { AnalysisEnergySurface } from "./components/AnalysisEnergySurface";
import { AnalysisFrequencySurface } from "./components/AnalysisFrequencySurface";
import { AnalysisSurfaceTabs } from "./components/AnalysisSurfaceTabs";
import { AnalysisTableSurface } from "./components/AnalysisTableSurface";
import { DynamicStructureFactorView } from "./DynamicStructureFactorView";
import { filterSeriesForSurface, formatTableSummary, formatXAxisLabel, resourceStatusFromString, surfaceTitle, tableRowsLike, tableWindowTableId } from "./analysisWorkbenchModel";
import { SpinWaveGammaView } from "./SpinWaveGammaView";

const EMPTY_CHART_SERIES: readonly ChartSeries[] = [];

export interface AnalysisPlotsViewProps {
  activeSurface?: AnalysisWorkbenchSurface;
  dynamicStructureFactor?: DynamicStructureFactorResource | null;
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  kernel: KernelApi;
  onClearRange: () => void;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange: (range: ChartValueRange) => void;
  onSeriesSelect: (series: ChartSeries) => void;
  onSurfaceChange?: (surface: AnalysisWorkbenchSurface) => void;
  range: ChartValueRange | null;
  selectedPoint: AnalysisChartCursorPoint | null;
  selectedStageId?: string | null;
  solverEnergySeries: readonly ChartSeries[];
  solverEnergyStatus: string;
  spinWaveGamma?: SpinWaveGammaResource | null;
  spinWaveGammaStatus?: string;
  tableRowsStatus: string;
  visibleTable: ChartTableWindow | null;
  xAxisId: string;
  yAxisIds: string[];
}

export function AnalysisPlotsView({
  activeSurface = "overview",
  dynamicStructureFactor = null,
  frequencyDomainSeries = EMPTY_CHART_SERIES,
  frequencyDomainStatus = "idle",
  frequencyDomainTitle = "Frequency-domain analysis",
  frequencyDomainUnavailableReason = null,
  kernel,
  onClearRange,
  onPointSelect,
  onRangeChange,
  onSeriesSelect,
  onSurfaceChange = () => {},
  range,
  selectedPoint,
  selectedStageId,
  solverEnergySeries,
  solverEnergyStatus,
  spinWaveGamma = null,
  spinWaveGammaStatus = "idle",
  tableRowsStatus,
  visibleTable,
  xAxisId,
  yAxisIds,
}: AnalysisPlotsViewProps) {
  const tableSurfaceActive = activeSurface === "overview" || activeSurface === "dynamics" || activeSurface === "convergence";
  const table = useMemo<TableRowsLike | null>(() => tableRowsLike(visibleTable), [visibleTable]);
  const chartSeries = useMemo(
    () => table && tableSurfaceActive
      ? filterSeriesForSurface(buildScalarChartSeries(table, {
          dataRevision: visibleTable?.revision ?? null,
          status: resourceStatusFromString(tableRowsStatus),
          tableId: tableWindowTableId(visibleTable),
          xAxisId,
          yAxisIds,
        }), activeSurface)
      : [],
    [activeSurface, table, tableRowsStatus, tableSurfaceActive, visibleTable, xAxisId, yAxisIds],
  );
  const showFrequency = (activeSurface === "overview" || activeSurface === "frequency") && (frequencyDomainSeries.length > 0 || frequencyDomainStatus === "loading" || frequencyDomainStatus === "error");

  return (
    <div className="fm-analysis-plots">
      {!selectedStageId ? <AnalysisSurfaceTabs active={activeSurface} onChange={onSurfaceChange} /> : null}
      <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
        <header className="fm-analysis-plots__header">
          <h3>{selectedStageId ? "Hysteresis Plot" : surfaceTitle(activeSurface)}</h3>
          <span>{selectedStageId ? "Hysteresis loop points & branches" : formatTableSummary(visibleTable, tableRowsStatus)}</span>
        </header>
        {selectedStageId ? <HysteresisChart kernel={kernel} stageId={selectedStageId} /> : null}
        {!selectedStageId && tableSurfaceActive ? <AnalysisTableSurface chartSeries={chartSeries} kernel={kernel} onClearRange={onClearRange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSeriesSelect={onSeriesSelect} range={range} selectedPoint={selectedPoint} status={tableRowsStatus} table={visibleTable} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)} /> : null}
        {!selectedStageId && (activeSurface === "overview" || activeSurface === "energy") ? <AnalysisEnergySurface kernel={kernel} onPointSelect={onPointSelect} onSeriesSelect={onSeriesSelect} series={solverEnergySeries} status={solverEnergyStatus} /> : null}
        {!selectedStageId && showFrequency ? <AnalysisFrequencySurface kernel={kernel} onPointSelect={onPointSelect} onSeriesSelect={onSeriesSelect} selectedPoint={selectedPoint} series={frequencyDomainSeries} status={frequencyDomainStatus} title={frequencyDomainTitle} unavailableReason={frequencyDomainUnavailableReason} /> : null}
      </section>
      {activeSurface === "overview" && spinWaveGamma ? <SpinWaveGammaView resource={spinWaveGamma} status={spinWaveGammaStatus} /> : null}
      {activeSurface === "overview" && dynamicStructureFactor ? <DynamicStructureFactorView resource={dynamicStructureFactor} /> : null}
    </div>
  );
}
