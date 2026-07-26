import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

import type { ChartSeries } from "../chartTableModel";
import { formatSeriesCount } from "../analysisWorkbenchModel";
import { AnalysisSeriesLegend } from "./AnalysisSeriesLegend";
import { EChartsSurface } from "./EChartsSurface";

export function AnalysisEnergySurface({ kernel, onPointSelect, onSeriesSelect, series, status }: { kernel: KernelApi; onPointSelect: (point: AnalysisChartCursorPoint) => void; onSeriesSelect: (series: ChartSeries) => void; series: readonly ChartSeries[]; status: string }) {
  if (series.length === 0) return <div className="fm-analysis-plots__empty" role="status">No energy history available</div>;
  return (
    <div className="fm-analysis-plots__subchart fm-analysis-plots__subchart--energy">
      <header className="fm-analysis-plots__subchart-header"><h4>Energy history</h4><span>{`${formatSeriesCount(series.length)} / time [s]`}</span></header>
      <AnalysisSeriesLegend ariaLabel="Energy series legend" onSelect={onSeriesSelect} series={series} />
      <EChartsSurface bus={kernel.bus} dataStatus={status} onPointSelect={onPointSelect} series={series} xAxisLabel="time [s]" />
    </div>
  );
}
