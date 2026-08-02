import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartRangeMode, AnalysisWorkbenchSurface, ChartLiveMode } from "@/kernel/workspace/analysisPlotsWorkspace";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import type { AxisColumnDescriptor } from "@/shared/domain/analysis/TableColumnList";
import type { ChartSeriesSelectionScope } from "@/shared/analysis-charts/chartSeriesSelection";

import type { ChartSeries, ChartValueRange } from "./chartTableModel";

export interface AnalysisPlotsViewProps {
  activeSurface?: AnalysisWorkbenchSurface;
  availableColumns?: readonly AxisColumnDescriptor[];
  frequencyDomainSeries?: readonly ChartSeries[];
  frequencyDomainStatus?: string;
  frequencyDomainTitle?: string;
  frequencyDomainUnavailableReason?: string | null;
  selectedSeriesIds: readonly string[];
  kernel: KernelApi;
  liveMode?: ChartLiveMode;
  onClearRange: () => void;
  onLiveModeToggle?: () => void;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange: (range: ChartValueRange) => void;
  onSelectXAxis?: (columnId: string) => void;
  onRangeModeChange?: (mode: AnalysisChartRangeMode) => void;
  onTargetPointsChange?: (targetPoints: 160 | 400 | 800 | 1600 | 3200 | 5000) => void;
  onSeriesSelect: (series: ChartSeries) => void;
  onSurfaceChange?: (surface: AnalysisWorkbenchSurface) => void;
  onSelectedSeriesIdsChange?: (
    scope: ChartSeriesSelectionScope,
    selectedSeriesIds: string[],
  ) => void;
  range: ChartValueRange | null;
  rangeMode?: AnalysisChartRangeMode;
  selectedPoint: AnalysisChartCursorPoint | null;
  selectedStageId?: string | null;
  solverEnergySeries: readonly ChartSeries[];
  solverEnergyStatus: string;
  tableRowsStatus: string;
  targetPoints?: 160 | 400 | 800 | 1600 | 3200 | 5000;
  visibleTable: ChartTableWindow | null;
  xAxisId: string;
}
