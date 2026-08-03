"use client";

import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { buildScalarChartSeries } from "./chartTableModel";
import { AnalysisFrequencySurface } from "./components/AnalysisFrequencySurface";
import { AnalysisSurfaceTabs } from "./components/AnalysisSurfaceTabs";
import { AnalysisTableSurface } from "./components/AnalysisTableSurface";
import { DynamicStructureFactorView } from "./DynamicStructureFactorView";
import { SpinWaveGammaView } from "./SpinWaveGammaView";
import { formatXAxisLabel, surfaceTitle, tableRowsLike, tableWindowTableId } from "./analysisWorkbenchModel";
import type { ChartSeries } from "./chartTableModel";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartValueRange } from "./chartTableModel";

type AnalysisPlotsViewInput = {
  activeSurface: AnalysisSurface;
  comparisonDatasetRef?: string | null;
  comparisonTable?: ChartTableWindow | null;
  comparisonVisibleRevision?: string | number | null;
  datasetRefs?: readonly string[];
  dynamicStructureFactor?: Parameters<typeof DynamicStructureFactorView>[0]["resource"];
  dynamicStructureFactorStatus?: string;
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  frequencyDomainProvenance?: string | null;
  kernel: KernelApi;
  onDatasetRefChange?: (datasetRef: string | null) => void;
  onComparisonDatasetRefChange?: (datasetRef: string | null) => void;
  onPointSelect?: (point: AnalysisChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  onSelectedSeriesIdsChange?: (seriesIds: string[]) => void;
  onSurfaceChange?: (surface: AnalysisSurface) => void;
  range?: ChartValueRange | null;
  selectedDatasetRef?: string | null;
  selectedPoint?: AnalysisChartCursorPoint | null;
  selectedSeriesIds?: readonly string[];
  selectedStageId?: string | null;
  surfaceProvenance?: Partial<Record<AnalysisSurface, string>>;
  spinWaveGamma?: Parameters<typeof SpinWaveGammaView>[0]["resource"];
  spinWaveGammaStatus?: string;
  table?: ChartTableWindow | null;
  tableStatus?: string;
  tableUnsupportedReason?: string | null;
  xAxisId?: string | null;
};

export function AnalysisPlotsView(props: AnalysisPlotsViewInput) {
  const { activeSurface, comparisonDatasetRef = null, comparisonTable = null, comparisonVisibleRevision = null, datasetRefs = [], dynamicStructureFactor = null, dynamicStructureFactorStatus = "idle", frequencyDomainProvenance = null, frequencyDomainSeries = [], frequencyDomainStatus = "idle", frequencyDomainTitle = "Frequency domain", frequencyDomainUnavailableReason = null, kernel, onDatasetRefChange = () => undefined, onComparisonDatasetRefChange = () => undefined, onSurfaceChange = () => undefined, range = null, selectedDatasetRef = null, selectedPoint = null, selectedSeriesIds = [], selectedStageId = null, spinWaveGamma = null, spinWaveGammaStatus = "idle", surfaceProvenance = {}, table = null, tableStatus = "idle", tableUnsupportedReason = null, xAxisId: selectedXAxisId = null } = props;
  const onPointSelect = props.onPointSelect ?? ignorePointSelection;
  const onRangeChange = props.onRangeChange ?? ignoreRangeSelection;
  const onSelectedSeriesIdsChange = props.onSelectedSeriesIdsChange ?? ignoreSeriesSelection;
  const resolvedTable = table;
  const resolvedDatasetRef = selectedDatasetRef;
  const resolvedTableStatus = tableStatus;
  const surface = activeSurface;
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
  const xAxisId = selectedXAxisId ?? resolvedTable?.columns[0]?.column_id ?? "x";
  const comparisonSeries = useMemo(() => {
    const rows = tableRowsLike(comparisonTable);
    return rows && comparisonTable ? buildScalarChartSeries(rows, {
      dataRevision: comparisonTable.revision,
      status: "ready",
      tableId: tableWindowTableId(comparisonTable),
      xAxisId: comparisonTable.columns[0]?.column_id ?? "x",
      yAxisIds: comparisonTable.columns.slice(1).map((column) => column.column_id),
    }) : [];
  }, [comparisonTable]);
  const compatibleSeries = chartSeries.filter((left) => comparisonSeries.some((right) => right.quantity === left.quantity && right.unit === left.unit));
  const tableProvenance = (surface === "dynamics" || surface === "comparison") && resolvedDatasetRef
    ? `${resolvedDatasetRef}${resolvedTable?.revision == null ? "" : ` · revision ${resolvedTable.revision}`}`
    : null;
  const provenance = tableProvenance ?? (surface === "frequency-response" || surface === "eigenmodes" ? frequencyDomainProvenance : null) ?? surfaceProvenance[surface] ?? null;
  const datasetPrompt = !resolvedDatasetRef
    ? <div className="fm-analysis-plots__empty" role="status">Select a dataset or artifact</div>
    : null;

  return <div className="fm-analysis-plots">
    <AnalysisSurfaceTabs active={surface} onChange={onSurfaceChange} />
    <section className="fm-analysis-plots__panel fm-analysis-plots__panel--primary">
      <header className="fm-analysis-plots__header">
        <div><h3>{surfaceTitle(surface)}</h3>{provenance ? <span>Dataset provenance: {provenance}</span> : null}</div>
        <Select value={selectedDatasetRef ?? ""} onValueChange={(value) => onDatasetRefChange(value || null)}>
          <SelectTrigger aria-label="Analysis dataset"><SelectValue placeholder="Select a dataset" /></SelectTrigger>
          <SelectContent>{datasetRefs.map((ref) => <SelectItem key={ref} value={ref}>{ref}</SelectItem>)}</SelectContent>
        </Select>
      </header>
      {surface === "dynamics" ? (datasetPrompt ?? <AnalysisTableSurface chartSeries={chartSeries} kernel={kernel} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} status={tableUnsupportedReason ? "unsupported" : resolvedTableStatus} table={resolvedTable} unsupportedReason={tableUnsupportedReason} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)} />) : null}
      {surface === "spectrum" ? <SpinWaveGammaView resource={spinWaveGamma} status={spinWaveGammaStatus} /> : null}
      {surface === "dispersion" ? <DynamicStructureFactorView resource={dynamicStructureFactor} status={dynamicStructureFactorStatus} /> : null}
      {surface === "frequency-response" || surface === "eigenmodes" ? <AnalysisFrequencySurface kernel={kernel} onPointSelect={onPointSelect} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} series={frequencyDomainSeries} status={frequencyDomainStatus} title={frequencyDomainTitle} unavailableReason={frequencyDomainUnavailableReason} /> : null}
      {surface === "hysteresis" ? (selectedStageId ? <HysteresisChart kernel={kernel} stageId={selectedStageId} /> : <div className="fm-analysis-plots__empty" role="status">Select a hysteresis stage</div>) : null}
      {surface === "comparison" ? (!resolvedDatasetRef ? <div className="fm-analysis-plots__empty" role="status">Select a published dataset before comparison.</div> : !comparisonDatasetRef ? <div className="fm-analysis-plots__empty" role="status">Select a second published dataset compatible with {resolvedDatasetRef} to compare series.<Select value="" onValueChange={(value) => onComparisonDatasetRefChange(value || null)}><SelectTrigger aria-label="Comparison dataset"><SelectValue placeholder="Select second dataset" /></SelectTrigger><SelectContent>{datasetRefs.filter((ref) => ref !== resolvedDatasetRef).map((ref) => <SelectItem key={ref} value={ref}>{ref}</SelectItem>)}</SelectContent></Select></div> : <div className="fm-analysis-plots__comparison"><strong>Compatible series</strong><span>{resolvedDatasetRef} · revision {resolvedTable?.revision ?? "unknown"}</span><span>{comparisonDatasetRef} · revision {comparisonVisibleRevision ?? comparisonTable?.revision ?? "unknown"}</span>{compatibleSeries.length === 0 ? <div role="status">No compatible quantity and unit series are published by both datasets.</div> : <div className="fm-analysis-plots__comparison-panes"><AnalysisTableSurface chartSeries={compatibleSeries} kernel={kernel} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} status={resolvedTableStatus} table={resolvedTable} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(compatibleSeries, xAxisId)} /><AnalysisTableSurface chartSeries={comparisonSeries.filter((right) => compatibleSeries.some((left) => left.quantity === right.quantity && left.unit === right.unit))} kernel={kernel} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} status="ready" table={comparisonTable} xAxisId={comparisonTable?.columns[0]?.column_id ?? "x"} xAxisLabel={formatXAxisLabel(comparisonSeries, comparisonTable?.columns[0]?.column_id ?? "x")} /></div>}</div>) : null}
    </section>
  </div>;
}

function ignorePointSelection(_point: AnalysisChartCursorPoint): void {}
function ignoreRangeSelection(_range: ChartValueRange): void {}
function ignoreSeriesSelection(_seriesIds: string[]): void {}
