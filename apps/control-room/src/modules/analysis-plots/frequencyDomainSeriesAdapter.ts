import type {
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { finiteFrequencySeries } from "@/shared/analysis-charts/frequencyRenderModels";

import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

interface FrequencyDomainSeriesSelectionIdentity {
  analysisRunId?: string | null;
  analysisStageId?: string | null;
}

export function frequencyDomainChartSeriesForAnalysisPlots<TPoint>(
  model: FrequencyDomainChartBuildResult<TPoint>,
  selectionIdentity?: FrequencyDomainSeriesSelectionIdentity | null,
): ChartSeries[] {
  return finiteFrequencySeries(model).map((series) => ({
    ...series,
    sourceIdentity: series.sourceIdentity
      ? {
          ...series.sourceIdentity,
          runId:
            selectionIdentity?.analysisRunId ?? series.sourceIdentity.runId,
          stageId:
            selectionIdentity?.analysisStageId ?? series.sourceIdentity.stageId,
        }
      : undefined,
  }));
}

export function frequencyDomainPrimarySeries(
  series: readonly FrequencyDomainChartSeries[],
): FrequencyDomainChartSeries | null {
  return series.find((entry) => entry.points.length > 0) ?? null;
}

export function frequencyDomainXAxisLabel(
  series: readonly ChartSeries[],
): string {
  const first = series.find((entry) => entry.points.length > 0) ?? series[0];
  if (!first) return "x";
  switch (first.source.tableId) {
    case "frequency-domain:eigen-spectrum":
      return "mode index";
    case "frequency-domain:eigen-dispersion":
      return first.xUnit ? `path_s [${first.xUnit}]` : "path_s";
    case "frequency-domain:response-sweep":
      return first.xUnit ? `frequency [${first.xUnit}]` : "frequency";
    default:
      return first.xUnit ? `x [${first.xUnit}]` : "x";
  }
}
