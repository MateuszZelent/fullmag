"use client";

import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { Button } from "@/shared/ui/Button";

import { buildScalarChartSeries } from "./chartTableModel";
import { AnalysisFrequencySurface } from "./components/AnalysisFrequencySurface";
import { AnalysisSurfaceTabs } from "./components/AnalysisSurfaceTabs";
import { AnalysisTableSurface } from "./components/AnalysisTableSurface";
import { DynamicStructureFactorView } from "./DynamicStructureFactorView";
import { SpinWaveGammaView } from "./SpinWaveGammaView";
import { formatXAxisLabel, tableRowsLike, tableWindowTableId } from "./analysisWorkbenchModel";
import type { ChartSeries } from "./chartTableModel";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { ChartValueRange } from "./chartTableModel";
import { descriptorForSurface } from "@/shared/domain/analysis/analysisSurfaceDescriptor";

type AnalysisPlotsViewInput = {
  activeSurface: AnalysisSurface;
  comparisonDatasetRef?: string | null;
  comparisonSelectedSeriesKeys?: readonly string[];
  comparisonTable?: ChartTableWindow | null;
  comparisonTableStatus?: string;
  comparisonTableUnsupportedReason?: string | null;
  comparisonVisibleRevision?: string | number | null;
  frequencyDomainCalculationMode?: string;
  descriptorId?: string | null;
  comparisonPrimaryDisplayUnits?: Readonly<Record<string, string>>;
  comparisonSecondaryDisplayUnits?: Readonly<Record<string, string>>;
  displayUnits?: Readonly<Record<string, string>>;
  datasetRefs?: readonly string[];
  dynamicStructureFactor?: Parameters<typeof DynamicStructureFactorView>[0]["resource"];
  dynamicStructureFactorStatus?: string;
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  frequencyDomainProvenance?: string | null;
  frequencyDomainPresentation?: ChartDataPresentationState;
  kernel: KernelApi;
  onDatasetRefChange?: (datasetRef: string | null) => void;
  onDisplayUnitsChange?: (patch: Record<string, string>) => void;
  onComparisonDatasetRefChange?: (datasetRef: string | null) => void;
  onComparisonPrimaryDisplayUnitsChange?: (patch: Record<string, string>) => void;
  onComparisonSelectedSeriesKeysChange?: (seriesKeys: string[]) => void;
  onComparisonSecondaryDisplayUnitsChange?: (patch: Record<string, string>) => void;
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
  sourceChartId?: string | null;
  hasComparisonSelection?: boolean;
  xAxisId?: string | null;
};

export function AnalysisPlotsView(props: AnalysisPlotsViewInput) {
  const { activeSurface, comparisonDatasetRef = null, comparisonPrimaryDisplayUnits = {}, comparisonSecondaryDisplayUnits = {}, comparisonSelectedSeriesKeys = [], comparisonTable = null, comparisonTableStatus = "idle", comparisonTableUnsupportedReason = null, comparisonVisibleRevision = null, datasetRefs = [], descriptorId = null, displayUnits = {}, dynamicStructureFactor = null, dynamicStructureFactorStatus = "idle", frequencyDomainCalculationMode, frequencyDomainProvenance = null, frequencyDomainSeries = [], frequencyDomainStatus = "idle", frequencyDomainTitle = "Frequency domain", frequencyDomainUnavailableReason = null, hasComparisonSelection = false, kernel, onDatasetRefChange = () => undefined, onComparisonDatasetRefChange = () => undefined, onComparisonPrimaryDisplayUnitsChange = () => undefined, onComparisonSelectedSeriesKeysChange = () => undefined, onComparisonSecondaryDisplayUnitsChange = () => undefined, onSurfaceChange = () => undefined, range = null, selectedDatasetRef = null, selectedPoint = null, selectedSeriesIds = [], selectedStageId = null, spinWaveGamma = null, spinWaveGammaStatus = "idle", surfaceProvenance = {}, table = null, tableStatus = "idle", tableUnsupportedReason = null, xAxisId: selectedXAxisId = null } = props;
  const onPointSelect = props.onPointSelect ?? ignorePointSelection;
  const onDisplayUnitsChange = props.onDisplayUnitsChange ?? ignoreDisplayUnitsChange;
  const onRangeChange = props.onRangeChange ?? ignoreRangeSelection;
  const onSelectedSeriesIdsChange = props.onSelectedSeriesIdsChange ?? ignoreSeriesSelection;
  const resolvedTable = table;
  const resolvedDatasetRef = selectedDatasetRef;
  const resolvedTableStatus = tableStatus;
  const surface = activeSurface;
  const surfaceDescriptor = descriptorForSurface(surface);
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
  const compatibleSeries = chartSeries.filter((left) => comparisonSeries.some((right) => comparisonSeriesKey(right) === comparisonSeriesKey(left)));
  const availableComparisonSeriesKeys = compatibleSeries.map(comparisonSeriesKey);
  const selectedComparisonSeriesKeys = hasComparisonSelection
    ? comparisonSelectedSeriesKeys
    : availableComparisonSeriesKeys;
  const selectedComparisonKeySet = new Set(selectedComparisonSeriesKeys);
  const selectedPrimaryComparisonSeries = compatibleSeries.filter((series) => selectedComparisonKeySet.has(comparisonSeriesKey(series)));
  const selectedSecondaryComparisonSeries = comparisonSeries.filter((series) => selectedComparisonKeySet.has(comparisonSeriesKey(series)));
  const comparisonKeysForSeriesIds = (seriesIds: readonly string[], paneSeries: readonly ChartSeries[]) =>
    paneSeries.filter((series) => seriesIds.includes(series.id)).map(comparisonSeriesKey);
  const tableProvenance = (surface === "dynamics" || surface === "comparison") && resolvedDatasetRef
    ? `${resolvedDatasetRef}${resolvedTable?.revision == null ? "" : ` · revision ${resolvedTable.revision}`}`
    : null;
  const provenance = tableProvenance ?? (surface === "frequency-response" || surface === "eigenmodes" ? frequencyDomainProvenance : null) ?? surfaceProvenance[surface] ?? null;
  const chartId = props.sourceChartId ?? (resolvedDatasetRef ? `${surface}:${resolvedDatasetRef}` : undefined);
  const datasetPrompt = !resolvedDatasetRef
    ? <div className="fm-analysis-plots__empty" role="status">Select a dataset or artifact</div>
    : null;

  return <div className="fm-analysis-plots">
    <AnalysisSurfaceTabs active={surface} onChange={onSurfaceChange} />
    <section
      className="fm-analysis-plots__panel fm-analysis-plots__panel--primary"
      data-analysis-surface={surfaceDescriptor.surface}
    >
      <header className="fm-analysis-plots__header">
        <div><h3>{surfaceDescriptor.title}</h3>{provenance ? <span>Dataset provenance: {provenance}</span> : null}</div>
        <Select value={selectedDatasetRef ?? ""} onValueChange={(value) => onDatasetRefChange(value || null)}>
          <SelectTrigger aria-label="Analysis dataset"><SelectValue placeholder="Select a dataset" /></SelectTrigger>
          <SelectContent>{datasetRefs.map((ref) => <SelectItem key={ref} value={ref}>{ref}</SelectItem>)}</SelectContent>
        </Select>
      </header>
      {surface === "dynamics" ? (datasetPrompt ?? <AnalysisTableSurface chartId={chartId} chartSeries={chartSeries} descriptorId={descriptorId ?? undefined} displayUnits={displayUnits} kernel={kernel} onDisplayUnitsChange={onDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} status={tableUnsupportedReason ? "unsupported" : resolvedTableStatus} table={resolvedTable} unsupportedReason={tableUnsupportedReason} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)} />) : null}
      {surface === "spectrum" ? <SpinWaveGammaView resource={spinWaveGamma} status={spinWaveGammaStatus} /> : null}
      {surface === "dispersion" ? <DynamicStructureFactorView resource={dynamicStructureFactor} status={dynamicStructureFactorStatus} /> : null}
      {surface === "frequency-response" || surface === "eigenmodes" ? <AnalysisFrequencySurface calculationMode={frequencyDomainCalculationMode} chartId={chartId} descriptorId={descriptorId ?? undefined} displayUnits={displayUnits} kernel={kernel} onDisplayUnitsChange={onDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} presentation={props.frequencyDomainPresentation} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} series={frequencyDomainSeries} status={frequencyDomainStatus} title={frequencyDomainTitle} unavailableReason={frequencyDomainUnavailableReason} /> : null}
      {surface === "hysteresis" ? (selectedStageId ? <HysteresisChart kernel={kernel} stageId={selectedStageId} /> : <div className="fm-analysis-plots__empty" role="status">Select a hysteresis stage</div>) : null}
      {surface === "comparison" ? <div className="fm-analysis-plots__comparison">
        <div className="fm-analysis-plots__comparison-selector">
          <Select value={comparisonDatasetRef ?? ""} onValueChange={(value) => onComparisonDatasetRefChange(value || null)}>
            <SelectTrigger aria-label="Comparison dataset"><SelectValue placeholder="Select second dataset" /></SelectTrigger>
            <SelectContent>{datasetRefs.filter((ref) => ref !== resolvedDatasetRef).map((ref) => <SelectItem key={ref} value={ref}>{ref}</SelectItem>)}</SelectContent>
          </Select>
          <Button aria-label="Clear comparison dataset" disabled={!comparisonDatasetRef} onClick={() => onComparisonDatasetRefChange(null)} type="button">Clear comparison</Button>
        </div>
        {!resolvedDatasetRef ? <div className="fm-analysis-plots__empty" role="status">Select a published dataset before comparison.</div> : !comparisonDatasetRef ? <div className="fm-analysis-plots__empty" role="status">Select a second published dataset compatible with {resolvedDatasetRef} to compare series.</div> : <><strong>Compatible series</strong><span>{resolvedDatasetRef} · revision {resolvedTable?.revision ?? "unknown"}</span><span>{comparisonDatasetRef} · revision {comparisonVisibleRevision ?? comparisonTable?.revision ?? "unknown"}</span>{comparisonTableStatus !== "ready" || comparisonTableUnsupportedReason ? <AnalysisTableSurface chartId={`comparison:${comparisonDatasetRef}`} chartSeries={[]} descriptorId={descriptorId ?? undefined} displayUnits={comparisonSecondaryDisplayUnits} kernel={kernel} onDisplayUnitsChange={onComparisonSecondaryDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onComparisonSelectedSeriesKeysChange} range={range} selectedPoint={selectedPoint} selectedSeriesIds={[]} status={comparisonTableUnsupportedReason ? "unsupported" : comparisonTableStatus} table={comparisonTable} unsupportedReason={comparisonTableUnsupportedReason} xAxisId={comparisonTable?.columns[0]?.column_id ?? "x"} xAxisLabel={formatXAxisLabel(comparisonSeries, comparisonTable?.columns[0]?.column_id ?? "x")} /> : compatibleSeries.length === 0 ? <div role="status">No compatible quantity and unit series are published by both datasets.</div> : <div className="fm-analysis-plots__comparison-panes"><AnalysisTableSurface chartId={chartId} chartSeries={compatibleSeries} descriptorId={descriptorId ?? undefined} displayUnits={comparisonPrimaryDisplayUnits} kernel={kernel} onDisplayUnitsChange={onComparisonPrimaryDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={(ids) => onComparisonSelectedSeriesKeysChange(comparisonKeysForSeriesIds(ids, compatibleSeries))} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedPrimaryComparisonSeries.map((series) => series.id)} status={resolvedTableStatus} table={resolvedTable} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(compatibleSeries, xAxisId)} /><AnalysisTableSurface chartId={`comparison:${comparisonDatasetRef}`} chartSeries={comparisonSeries.filter((series) => availableComparisonSeriesKeys.includes(comparisonSeriesKey(series)))} descriptorId={descriptorId ?? undefined} displayUnits={comparisonSecondaryDisplayUnits} kernel={kernel} onDisplayUnitsChange={onComparisonSecondaryDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={(ids) => onComparisonSelectedSeriesKeysChange(comparisonKeysForSeriesIds(ids, comparisonSeries))} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSecondaryComparisonSeries.map((series) => series.id)} status={comparisonTableStatus} table={comparisonTable} unsupportedReason={comparisonTableUnsupportedReason} xAxisId={comparisonTable?.columns[0]?.column_id ?? "x"} xAxisLabel={formatXAxisLabel(comparisonSeries, comparisonTable?.columns[0]?.column_id ?? "x")} /></div>}</>}</div> : null}
    </section>
  </div>;
}

function ignorePointSelection(): void {}
function ignoreRangeSelection(): void {}
function ignoreSeriesSelection(): void {}
function ignoreDisplayUnitsChange(): void {}

export function comparisonSeriesKey(series: Pick<ChartSeries, "quantity" | "unit">): string {
  return `${encodeURIComponent(series.quantity)}|${encodeURIComponent(series.unit)}`;
}
