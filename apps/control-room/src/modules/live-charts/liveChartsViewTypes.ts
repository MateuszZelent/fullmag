import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { LiveChartPresetId } from "./liveChartsModel";

export interface LiveChartsViewProps {
  descriptorId: LiveChartPresetId;
  fitRequest: number;
  isFollowing: boolean;
  onDescriptorChange: (id: LiveChartPresetId) => void;
  onExport: (format: "csv" | "tsv" | "png") => void;
  onFit: () => void;
  onRangeSelected: (fromSI: number, toSI: number) => void;
  onSeriesChange: (ids: string[]) => void;
  onToggleFollow: () => void;
  presentation: ChartDataPresentationState;
  series: readonly ChartSeries[];
  selectedSeriesIds: readonly string[];
  title: string;
  xAxisLabel: string;
}
