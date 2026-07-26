import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

import type { ChartSeries } from "../chartTableModel";
import { buildFrequencyDomainCursorSummary, buildFrequencyDomainWorkbenchSummary, buildFrequencyDomainWorkflowSummary, formatFrequencyDomainEmptyState, formatSeriesCount } from "../analysisWorkbenchModel";
import { frequencyDomainXAxisLabel } from "../frequencyDomainSeriesAdapter";
import { AnalysisSeriesLegend } from "./AnalysisSeriesLegend";
import { AnalysisStatusPill } from "./AnalysisStatusPill";
import { EChartsSurface } from "./EChartsSurface";

export function AnalysisFrequencySurface({ kernel, onPointSelect, onSeriesSelect, selectedPoint, series, status, title, unavailableReason }: { kernel: KernelApi; onPointSelect: (point: AnalysisChartCursorPoint) => void; onSeriesSelect: (series: ChartSeries) => void; selectedPoint: AnalysisChartCursorPoint | null; series: readonly ChartSeries[]; status: string; title: string; unavailableReason: string | null }) {
  const workflow = useMemo(() => buildFrequencyDomainWorkflowSummary(title), [title]);
  const workbench = useMemo(() => buildFrequencyDomainWorkbenchSummary(series, title, status), [series, status, title]);
  const selected = useMemo(() => buildFrequencyDomainCursorSummary(selectedPoint, title), [selectedPoint, title]);
  return (
    <div className="fm-analysis-plots__subchart fm-analysis-plots__subchart--frequency-domain">
      <header className="fm-analysis-plots__subchart-header"><h4>{title}</h4><span>{series.length > 0 ? formatSeriesCount(series.length) : status}</span></header>
      {series.length > 0 ? (
        <>
          {workflow ? <div aria-label="Frequency-domain workflow" className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-workflow"><AnalysisStatusPill label="Workflow" value={workflow.workflow} /><AnalysisStatusPill label="Next" value={workflow.next} /><AnalysisStatusPill label="Artifacts" value={workflow.artifacts} /><AnalysisStatusPill label="Inspector" value={workflow.inspector} /></div> : null}
          <div aria-label="Frequency-domain workbench" className="fm-analysis-plots__workbench"><AnalysisStatusPill label="Chart" value={workbench.chartKind} /><AnalysisStatusPill label="Points" value={workbench.pointCount} /><AnalysisStatusPill label="Frequency" value={workbench.frequencyRange} /><AnalysisStatusPill label="3D handoff" value={workbench.fieldHandoff} /><AnalysisStatusPill label="Status" value={workbench.status} /></div>
          <AnalysisSeriesLegend ariaLabel="Frequency-domain series legend" onSelect={onSeriesSelect} series={series} />
          <EChartsSurface bus={kernel.bus} dataStatus={status} onPointSelect={onPointSelect} series={series} xAxisLabel={frequencyDomainXAxisLabel(series)} />
          {selected ? <div aria-label="Selected frequency-domain point" className="fm-analysis-plots__status fm-analysis-plots__status--frequency-domain-selection"><AnalysisStatusPill label="Selected" value={selected.title} /><AnalysisStatusPill label={selected.xLabel} value={selected.xValue} /><AnalysisStatusPill label={selected.yLabel} value={selected.yValue} />{"linewidthValue" in selected && selected.linewidthValue ? <AnalysisStatusPill label="Linewidth" value={selected.linewidthValue} /> : null}<AnalysisStatusPill label="Inspector" value={selected.inspectorTarget} /></div> : null}
        </>
      ) : <div className="fm-analysis-plots__empty" role="status">{unavailableReason ?? formatFrequencyDomainEmptyState(status)}</div>}
    </div>
  );
}
