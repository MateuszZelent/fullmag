"use client";

import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { buildScalarChartSeries } from "./chartTableModel";
import { AnalysisFrequencySurface } from "./components/AnalysisFrequencySurface";
import { AnalysisEnergySurface } from "./components/AnalysisEnergySurface";
import { AnalysisSurfaceTabs } from "./components/AnalysisSurfaceTabs";
import { AnalysisTableSurface } from "./components/AnalysisTableSurface";
import { DynamicStructureFactorView } from "./DynamicStructureFactorView";
import { SpinWaveGammaView } from "./SpinWaveGammaView";
import { formatXAxisLabel, surfaceTitle, tableRowsLike, tableWindowTableId } from "./analysisWorkbenchModel";
import type { ChartSeries } from "./chartTableModel";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";

type LegacySurface = "overview" | "energy" | "convergence" | "frequency";
type AnalysisPlotsViewInput = {
  activeSurface?: AnalysisSurface | LegacySurface;
  datasetRefs?: readonly string[];
  dynamicStructureFactor?: Parameters<typeof DynamicStructureFactorView>[0]["resource"];
  dynamicStructureFactorStatus?: string;
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  kernel: KernelApi;
  onDatasetRefChange?: (datasetRef: string | null) => void;
  onSurfaceChange?: (surface: AnalysisSurface) => void;
  selectedDatasetRef?: string | null;
  selectedStageId?: string | null;
  spinWaveGamma?: Parameters<typeof SpinWaveGammaView>[0]["resource"];
  spinWaveGammaStatus?: string;
  table?: ChartTableWindow | null;
  tableStatus?: string;
  tableUnsupportedReason?: string | null;
  [legacyProp: string]: unknown;
};

export function AnalysisPlotsView(props: AnalysisPlotsViewInput) {
  const { activeSurface = "dynamics", datasetRefs = [], dynamicStructureFactor = null, dynamicStructureFactorStatus = "idle", frequencyDomainSeries = [], frequencyDomainStatus = "idle", frequencyDomainTitle = "Frequency domain", frequencyDomainUnavailableReason = null, kernel, onDatasetRefChange = () => undefined, onSurfaceChange = () => undefined, selectedDatasetRef = null, selectedStageId = null, spinWaveGamma = null, spinWaveGammaStatus = "idle", table = null, tableStatus = "idle", tableUnsupportedReason = null } = props;
  const legacy = props as { visibleTable?: ChartTableWindow | null; tableRowsStatus?: string; selectedSeriesIds?: readonly string[]; selectedPoint?: Parameters<typeof AnalysisTableSurface>[0]["selectedPoint"]; range?: Parameters<typeof AnalysisTableSurface>[0]["range"]; solverEnergySeries?: readonly ChartSeries[]; solverEnergyStatus?: string };
  const resolvedTable = table ?? legacy.visibleTable ?? null;
  const resolvedDatasetRef = selectedDatasetRef ?? (legacy.visibleTable ? legacy.visibleTable.tableId : null);
  const resolvedTableStatus = tableStatus === "idle" ? legacy.tableRowsStatus ?? tableStatus : tableStatus;
  const surface: AnalysisSurface = activeSurface === "overview" || activeSurface === "convergence" ? "dynamics" : activeSurface === "energy" ? "spectrum" : activeSurface === "frequency" ? "frequency-response" : activeSurface;
  const chartSeries = useMemo(() => {
    const rows = tableRowsLike(resolvedTable);
    return rows && resolvedTable ? buildScalarChartSeries(rows, {
      dataRevision: resolvedTable.revision,
      status: resolvedTableStatus === "error" ? "error" : "ready",
      tableId: tableWindowTableId(resolvedTable),
      xAxisId: resolvedTable.columns[0]?.column_id ?? "x",
      yAxisIds: resolvedTable.columns.slice(1).map((column) => column.column_id),
    }) : [];
  }, [resolvedTable, resolvedTableStatus]);
  const xAxisId = resolvedTable?.columns[0]?.column_id ?? "x";
  const datasetPrompt = !resolvedDatasetRef
    ? <div className="fm-analysis-plots__empty" role="status">Select a dataset or artifact</div>
    : null;

  return <div className="fm-analysis-plots">
    <AnalysisSurfaceTabs active={surface} onChange={onSurfaceChange} />
    <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
      <header className="fm-analysis-plots__header">
        <div><h3>{surfaceTitle(surface)}</h3><span>Dataset provenance: {resolvedDatasetRef ?? "none selected"}</span></div>
        <Select value={selectedDatasetRef ?? ""} onValueChange={(value) => onDatasetRefChange(value || null)}>
          <SelectTrigger aria-label="Analysis dataset"><SelectValue placeholder="Select a dataset" /></SelectTrigger>
          <SelectContent>{datasetRefs.map((ref) => <SelectItem key={ref} value={ref}>{ref}</SelectItem>)}</SelectContent>
        </Select>
      </header>
      {surface === "dynamics" ? (datasetPrompt ?? <AnalysisTableSurface chartSeries={chartSeries} kernel={kernel} onPointSelect={() => undefined} onRangeChange={() => undefined} onSelectedSeriesIdsChange={() => undefined} range={legacy.range ?? null} selectedPoint={legacy.selectedPoint ?? null} selectedSeriesIds={legacy.selectedSeriesIds ?? chartSeries.map((series) => series.id)} status={tableUnsupportedReason ? "unsupported" : resolvedTableStatus} table={resolvedTable} unsupportedReason={tableUnsupportedReason} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)} />) : null}
      {surface === "spectrum" ? <SpinWaveGammaView resource={spinWaveGamma} status={spinWaveGammaStatus} /> : null}
      {surface === "dispersion" ? <DynamicStructureFactorView resource={dynamicStructureFactor} status={dynamicStructureFactorStatus} /> : null}
      {surface === "frequency-response" || surface === "eigenmodes" ? <AnalysisFrequencySurface kernel={kernel} onPointSelect={() => undefined} onSelectedSeriesIdsChange={() => undefined} selectedPoint={null} selectedSeriesIds={frequencyDomainSeries.map((series) => series.id)} series={frequencyDomainSeries} status={frequencyDomainStatus} title={frequencyDomainTitle} unavailableReason={frequencyDomainUnavailableReason} /> : null}
      {surface === "hysteresis" ? (selectedStageId ? <HysteresisChart kernel={kernel} stageId={selectedStageId} /> : <div className="fm-analysis-plots__empty" role="status">Select a hysteresis stage</div>) : null}
      {surface === "comparison" ? <div className="fm-analysis-plots__empty" role="status">Select comparison datasets</div> : null}
      {activeSurface === "overview" && frequencyDomainSeries.length > 0 ? <AnalysisFrequencySurface kernel={kernel} onPointSelect={() => undefined} onSelectedSeriesIdsChange={() => undefined} selectedPoint={legacy.selectedPoint ?? null} selectedSeriesIds={legacy.selectedSeriesIds ?? frequencyDomainSeries.map((series) => series.id)} series={frequencyDomainSeries} status={frequencyDomainStatus} title={frequencyDomainTitle} unavailableReason={frequencyDomainUnavailableReason} /> : null}
      {activeSurface === "energy" && legacy.solverEnergySeries ? <AnalysisEnergySurface kernel={kernel} onPointSelect={() => undefined} onSelectedSeriesIdsChange={() => undefined} selectedSeriesIds={legacy.selectedSeriesIds ?? legacy.solverEnergySeries.map((series) => series.id)} series={legacy.solverEnergySeries} status={legacy.solverEnergyStatus ?? "idle"} /> : null}
    </section>
  </div>;
}
