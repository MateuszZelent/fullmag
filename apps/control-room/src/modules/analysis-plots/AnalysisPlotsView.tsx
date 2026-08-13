"use client";

import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import {
  ANALYSIS_SUBVIEWS,
  type AnalysisSubview,
  type AnalysisSurface,
} from "@/kernel/workspace/analysisViewPreferences";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { descriptorForSurface } from "@/shared/domain/analysis/analysisSurfaceDescriptor";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { buildScalarChartSeries } from "./chartTableModel";
import { AnalysisFrequencySurface } from "./components/AnalysisFrequencySurface";
import { AnalysisSurfaceTabs } from "./components/AnalysisSurfaceTabs";
import { AnalysisTableSurface } from "./components/AnalysisTableSurface";
import { DynamicStructureFactorView } from "./DynamicStructureFactorView";
import { SpinWaveGammaView } from "./SpinWaveGammaView";
import { formatXAxisLabel, tableRowsLike, tableWindowTableId } from "./analysisWorkbenchModel";
import type { ChartSeries } from "./chartTableModel";
import type { AnalysisFrequencyPresentationState } from "./hooks/useAnalysisFrequencyData";
import type { ChartValueRange } from "./chartTableModel";
import type { FmrModalDrivenComparisonModel } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { ANALYSIS_COMPARISON_UNAVAILABLE_REASON } from "./analysisComparison";

type AnalysisPlotsViewInput = {
  activeSubview?: AnalysisSubview;
  activeSurface: AnalysisSurface;
  frequencyDomainCalculationMode?: string;
  frequencyDomainComparisonModel?: FmrModalDrivenComparisonModel;
  descriptorId?: string | null;
  comparisonUnavailableReason?: string | null;
  displayUnits?: Readonly<Record<string, string>>;
  datasetRefs?: readonly string[];
  dynamicStructureFactor?: Parameters<typeof DynamicStructureFactorView>[0]["resource"];
  dynamicStructureFactorStatus?: string;
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  frequencyDomainProvenance?: string | null;
  frequencyDomainPresentation?: AnalysisFrequencyPresentationState;
  kernel: KernelApi;
  onDatasetRefChange?: (datasetRef: string | null) => void;
  onDisplayUnitsChange?: (patch: Record<string, string>) => void;
  onPointSelect?: (point: AnalysisChartCursorPoint) => void;
  onRangeChange?: (range: ChartValueRange) => void;
  onSelectedSeriesIdsChange?: (seriesIds: string[]) => void;
  onSubviewChange?: (subview: AnalysisSubview) => void;
  onSurfaceChange?: (surface: AnalysisSurface) => void;
  range?: ChartValueRange | null;
  selectedDatasetRef?: string | null;
  selectedPoint?: AnalysisChartCursorPoint | null;
  selectedSeriesIds?: readonly string[];
  selectedStageId?: string | null;
  surfaceProvenance?: Partial<Record<AnalysisSurface, string>>;
  subviews?: readonly AnalysisSubview[];
  spinWaveGamma?: Parameters<typeof SpinWaveGammaView>[0]["resource"];
  spinWaveGammaStatus?: string;
  table?: ChartTableWindow | null;
  tableStatus?: string;
  tableUnsupportedReason?: string | null;
  sourceChartId?: string | null;
  xAxisId?: string | null;
};

const EMPTY_DISPLAY_UNITS: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_STRING_LIST: readonly string[] = Object.freeze([]);
const EMPTY_CHART_SERIES: readonly ChartSeries[] = Object.freeze([]);
const EMPTY_SURFACE_PROVENANCE: Partial<Record<AnalysisSurface, string>> =
  Object.freeze({});
export function AnalysisPlotsView(props: AnalysisPlotsViewInput) {
  const { activeSubview: requestedActiveSubview, activeSurface, datasetRefs = EMPTY_STRING_LIST, descriptorId = null, displayUnits = EMPTY_DISPLAY_UNITS, dynamicStructureFactor = null, dynamicStructureFactorStatus = "idle", frequencyDomainCalculationMode, frequencyDomainComparisonModel, frequencyDomainProvenance = null, frequencyDomainSeries = EMPTY_CHART_SERIES, frequencyDomainStatus = "idle", frequencyDomainTitle = "Frequency domain", frequencyDomainUnavailableReason = null, kernel, onDatasetRefChange = () => undefined, onSubviewChange = () => undefined, onSurfaceChange = () => undefined, range = null, selectedDatasetRef = null, selectedPoint = null, selectedSeriesIds = EMPTY_STRING_LIST, selectedStageId = null, spinWaveGamma = null, spinWaveGammaStatus = "idle", surfaceProvenance = EMPTY_SURFACE_PROVENANCE, table = null, tableStatus = "idle", tableUnsupportedReason = null, xAxisId: selectedXAxisId = null } = props;
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
  const tableProvenance = surface === "dynamics" && resolvedDatasetRef
    ? `${resolvedDatasetRef}${resolvedTable?.revision == null ? "" : ` · revision ${resolvedTable.revision}`}`
    : null;
  const provenance = tableProvenance ?? (surface === "resonance-fmr" || surface === "dispersion" ? frequencyDomainProvenance : null) ?? surfaceProvenance[surface] ?? null;
  const chartId = props.sourceChartId ?? (resolvedDatasetRef ? `${surface}:${resolvedDatasetRef}` : undefined);
  const datasetPrompt = !resolvedDatasetRef
    ? <div className="fm-analysis-plots__empty" role="status">Select a dataset or artifact</div>
    : null;
  const canonicalSubviews = ANALYSIS_SUBVIEWS[surface];
  const subviews = props.subviews ?? canonicalSubviews;
  const activeSubview = resolveActiveSubview(surface, requestedActiveSubview, subviews);
  const isDynamicStructureFactorSubview = activeSubview === "dynamics.s-k-f" || activeSubview === "dispersion.modal" && !frequencyDomainCalculationMode;
  const isFrequencySubview = !isDynamicStructureFactorSubview && (activeSubview === "dispersion.modal" || activeSubview === "dispersion.driven-map" || activeSubview === "dispersion.branches" || activeSubview === "resonance.eigenmodes" || activeSubview === "resonance.frequency-response" || activeSubview === "resonance.modal-driven");
  const isHysteresisSubview = activeSubview === "hysteresis.loop" || activeSubview === "hysteresis.branches";

  return <div className="fm-analysis-plots">
    <AnalysisSurfaceTabs active={surface} activeSubview={activeSubview} onChange={onSurfaceChange} onSubviewChange={onSubviewChange} subviews={subviews} />
    <section
      className="fm-analysis-plots__panel fm-analysis-plots__panel--primary"
      data-analysis-surface={surfaceDescriptor.surface}
    >
      <header className="fm-analysis-plots__header">
        <div><h3>{surfaceDescriptor.title}</h3>{provenance ? <span>Dataset provenance: {provenance}</span> : null}</div>
        {surface !== "comparison" ? <Select value={selectedDatasetRef ?? ""} onValueChange={(value) => onDatasetRefChange(value || null)}>
          <SelectTrigger aria-label="Analysis dataset"><SelectValue placeholder="Select a dataset" /></SelectTrigger>
          <SelectContent>{datasetRefs.map((ref) => <SelectItem key={ref} value={ref}>{ref}</SelectItem>)}</SelectContent>
        </Select> : null}
      </header>
      {activeSubview === "dynamics.time-traces" ? (resolvedDatasetRef ? <AnalysisTableSurface chartId={chartId} chartSeries={chartSeries} descriptorId={descriptorId ?? undefined} displayUnits={displayUnits} kernel={kernel} onDisplayUnitsChange={onDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} status={tableUnsupportedReason ? "unsupported" : resolvedTableStatus} table={resolvedTable} unsupportedReason={tableUnsupportedReason} xAxisId={xAxisId} xAxisLabel={formatXAxisLabel(chartSeries, xAxisId)} /> : datasetPrompt) : null}
      {activeSubview === "dynamics.temporal-fft" ? <SpinWaveGammaView resource={spinWaveGamma} status={spinWaveGammaStatus} /> : null}
      {isDynamicStructureFactorSubview ? <DynamicStructureFactorView resource={dynamicStructureFactor} status={dynamicStructureFactorStatus} /> : null}
      {isFrequencySubview ? <AnalysisFrequencySurface calculationMode={frequencyDomainCalculationMode} chartId={chartId} comparisonModel={activeSubview === "resonance.modal-driven" ? frequencyDomainComparisonModel : undefined} descriptorId={descriptorId ?? undefined} displayUnits={displayUnits} kernel={kernel} onDisplayUnitsChange={onDisplayUnitsChange} onPointSelect={onPointSelect} onRangeChange={onRangeChange} onSelectedSeriesIdsChange={onSelectedSeriesIdsChange} presentation={props.frequencyDomainPresentation} range={range} selectedPoint={selectedPoint} selectedSeriesIds={selectedSeriesIds} series={frequencyDomainSeries} status={frequencyDomainStatus} title={frequencyDomainTitle} unavailableReason={frequencyDomainUnavailableReason} /> : null}
      {isHysteresisSubview ? (selectedStageId ? <HysteresisChart kernel={kernel} stageId={selectedStageId} /> : <div className="fm-analysis-plots__empty" role="status">Select a hysteresis stage</div>) : null}
      {activeSubview === "comparison.sources" ? <div className="fm-analysis-plots__comparison fm-analysis-plots__empty" role="status">
        <strong>Comparison unavailable</strong>
        <span>{props.comparisonUnavailableReason ?? ANALYSIS_COMPARISON_UNAVAILABLE_REASON}</span>
      </div> : null}
    </section>
  </div>;
}

function ignorePointSelection(): void {}
function ignoreRangeSelection(): void {}
function ignoreSeriesSelection(): void {}
function ignoreDisplayUnitsChange(): void {}

function resolveActiveSubview(
  surface: AnalysisSurface,
  requested: AnalysisSubview | undefined,
  subviews: readonly AnalysisSubview[],
): AnalysisSubview {
  const canonicalSubviews = ANALYSIS_SUBVIEWS[surface] as readonly AnalysisSubview[];
  return requested && canonicalSubviews.includes(requested) && subviews.includes(requested)
    ? requested
    : canonicalSubviews[0];
}
