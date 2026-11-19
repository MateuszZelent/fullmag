"use client";

import { useMemo } from "react";

import type { StudyResultSeriesIdentity } from "@/kernel/api/apiTypes";
import { useStudyResultScalarsResource } from "@/kernel/resources/studyResultPlaybackResources";
import { useStudyStageResultsResource } from "@/kernel/resources/studyStageResultsResource";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import type { AxisColumnDescriptor } from "@/shared/domain/analysis/TableColumnList";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";

import {
  archivedScalarWindowToChartTable,
  latestCompletedLiveChartStageId,
  LIVE_CHART_ARCHIVE_WINDOW_SIZE,
  mergeArchivedScalarPages,
  planLiveChartArchivePages,
  shouldLoadLiveChartArchivedTable,
  selectLatestCompletedLiveChartResult,
} from "../liveChartsHistory";

export function useLiveChartArchivedTable({
  active,
  columns,
  currentSeries,
  paused,
  range,
}: {
  active: boolean;
  columns: readonly AxisColumnDescriptor[] | null;
  currentSeries: StudyResultSeriesIdentity | null | undefined;
  paused: boolean;
  range: ChartRangePreference;
}): ChartTableWindow | null {
  // Archive paging is a tail replacement for the default follow view. Existing
  // fixed/time ranges continue to use their live query semantics.
  const enabled = shouldLoadLiveChartArchivedTable({ active, paused, range });
  const executionResource = useStageExecutionResource({ enabled, pauseLoad: paused });
  const sceneRevision = useSessionStatusSelector(
    ({ data }) => data?.resources.scene_revision ?? null,
    { enabled, pauseLoad: paused },
  );
  const execution = executionResource.data;
  const hasCompletedStage = latestCompletedLiveChartStageId(execution) !== null;
  const resultsResource = useStudyStageResultsResource({
    stageId: currentSeries?.step_id,
    runId: currentSeries?.run_id,
    limit: 100,
    sceneRevision,
    enabled: enabled && hasCompletedStage && currentSeries !== null &&
      currentSeries !== undefined && sceneRevision !== null,
    pauseLoad: paused,
  });
  const catalog = resultsResource.data;
  const result = useMemo(() => selectLatestCompletedLiveChartResult({
    catalog,
    currentSeries,
    execution,
    sceneRevision,
  }), [catalog, currentSeries, execution, sceneRevision]);

  const probe = useStudyResultScalarsResource(result, 0, 1, { pauseLoad: paused });
  const probeWindow = probe.data?.coverage === "solver_series" &&
    Number.isSafeInteger(probe.data.total_rows) && probe.data.total_rows > 1
    ? probe.data
    : null;
  const probeTotalRows = probeWindow?.total_rows ?? null;
  const pagePlan = useMemo(
    () => probeTotalRows === null ? [] : planLiveChartArchivePages(probeTotalRows),
    [probeTotalRows],
  );
  const page0 = useStudyResultScalarsResource(
    pagePlan[0] ? result : null,
    pagePlan[0]?.start ?? 0,
    pagePlan[0]?.limit ?? 1,
    { pauseLoad: paused },
  );
  const page1 = useStudyResultScalarsResource(
    pagePlan[1] ? result : null,
    pagePlan[1]?.start ?? 0,
    pagePlan[1]?.limit ?? 1,
    { pauseLoad: paused },
  );
  const page2 = useStudyResultScalarsResource(
    pagePlan[2] ? result : null,
    pagePlan[2]?.start ?? 0,
    pagePlan[2]?.limit ?? 1,
    { pauseLoad: paused },
  );

  return useMemo(() => {
    if (!result || !probeWindow || !columns || pagePlan.length === 0) return null;
    const pages = pagePlan.flatMap((page, index) => {
      const window = [page0.data, page1.data, page2.data][index];
      return window ? [{ ...page, window }] : [];
    });
    if (pages.length !== pagePlan.length) return null;
    const merged = mergeArchivedScalarPages({
      pages,
      probe: probeWindow,
      result,
      totalRows: probeWindow.total_rows,
    });
    if (!merged) return null;
    return archivedScalarWindowToChartTable({
      columns,
      limit: Math.min(LIVE_CHART_ARCHIVE_WINDOW_SIZE, probeWindow.total_rows),
      result,
      start: pagePlan[0]!.start,
      window: merged,
    });
  }, [columns, page0.data, page1.data, page2.data, pagePlan, probeWindow, result]);
}
