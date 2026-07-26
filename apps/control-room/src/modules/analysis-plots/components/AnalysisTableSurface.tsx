import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { Button } from "@/shared/ui/Button";

import type { ChartSeries, ChartValueRange } from "../chartTableModel";
import { formatCursorPoint, formatRange, formatRangeValue, formatSeriesCount, tableWindowCursorEnd, tableWindowRowCount, tableWindowTotalRows } from "../analysisWorkbenchModel";
import { AnalysisSeriesLegend } from "./AnalysisSeriesLegend";
import { AnalysisStatusPill } from "./AnalysisStatusPill";
import { EChartsSurface } from "./EChartsSurface";

export function AnalysisTableSurface({ chartSeries, kernel, onClearRange, onPointSelect, onRangeChange, onSeriesSelect, range, selectedPoint, status, table, xAxisId, xAxisLabel }: {
  chartSeries: readonly ChartSeries[];
  kernel: KernelApi;
  onClearRange: () => void;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onRangeChange: (range: ChartValueRange) => void;
  onSeriesSelect: (series: ChartSeries) => void;
  range: ChartValueRange | null;
  selectedPoint: AnalysisChartCursorPoint | null;
  status: string;
  table: ChartTableWindow | null;
  xAxisId: string;
  xAxisLabel: string;
}) {
  return (
    <>
      <div className="fm-analysis-plots__status" aria-label="Chart status">
        <AnalysisStatusPill label="X" value={xAxisId} />
        <AnalysisStatusPill label="Y" value={formatSeriesCount(chartSeries.length)} />
        <AnalysisStatusPill label="Visible" value={String(tableWindowRowCount(table))} />
        <AnalysisStatusPill label="Total" value={table ? String(tableWindowTotalRows(table)) : "-"} />
        <AnalysisStatusPill label="Zoom" value={range ? formatRange(range) : "off"} />
        <AnalysisStatusPill label="Cursor" value={selectedPoint ? formatCursorPoint(selectedPoint) : "-"} />
      </div>
      <AnalysisSeriesLegend ariaLabel="Series legend" onSelect={onSeriesSelect} series={chartSeries} />
      <EChartsSurface bus={kernel.bus} dataStatus={status} onPointSelect={onPointSelect} onRangeChange={onRangeChange} series={chartSeries} xAxisLabel={xAxisLabel} />
      <footer className="fm-analysis-plots__range">
        <span>{range ? `zoom ${formatRangeValue(range.fromValue)}-${formatRangeValue(range.toValue)}` : table ? `cursor ${tableWindowCursorEnd(table)}` : "cursor -"}</span>
        <span>{`${tableWindowRowCount(table)} visible`}</span>
        {range ? <Button className="fm-analysis-plots__range-clear" size="sm" type="button" variant="secondary" onClick={onClearRange}>Clear zoom</Button> : null}
      </footer>
    </>
  );
}
