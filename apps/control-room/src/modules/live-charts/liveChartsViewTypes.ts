import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { LiveChartPresetId } from "./liveChartsModel";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import type { ChartExportRequest } from "@/shared/analysis-charts/chartExport";

export type LiveChartsExportRequest = ChartExportRequest;

export interface LiveChartsViewProps {
  descriptorId: LiveChartPresetId;
  fitRequest: number;
  isFollowing: boolean;
  onDescriptorChange: (id: LiveChartPresetId) => void;
  onExport: (format: "csv" | "tsv" | "png") => void;
  onFit: () => void;
  onChartSelected: () => void;
  onPointSelected: (seriesId: string, pointIndex: number, revision: string | number) => void;
  onRangeSelected: (fromSI: number, toSI: number) => void;
  onRequestedExportHandled: () => void;
  onRequestedExportFailed?: () => void;
  onSeriesChange: (ids: string[]) => void;
  onToggleFollow: () => void;
  presentation: ChartDataPresentationState;
  /** Command identity; keeps consecutive exports of the same format distinct. */
  requestedExportRequest?: LiveChartsExportRequest | null;
  series: readonly ChartSeries[];
  selectedSeriesIds: readonly string[];
  title: string;
  xAxisLabel: string;
  xAxisId?: string;
  xAxisOptions?: readonly { id: string; label: string }[];
  onXAxisChange?: (id: string) => void;
  range?: ChartRangePreference;
  onRangeChange?: (range: ChartRangePreference) => void;
}
