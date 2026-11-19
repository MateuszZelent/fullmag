import type {
  StageExecutionResource,
  StudyResultScalarWindow,
  StudyResultSeriesIdentity,
  StudyStageResult,
  StudyStageResultsResource,
} from "@/kernel/api/apiTypes";
import type { AxisColumnDescriptor } from "@/shared/domain/analysis/TableColumnList";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import { validateStudyResultScalars } from "@/kernel/api/studyResultPlayback";

export const LIVE_CHART_ARCHIVE_PAGE_SIZE = 2_048;
export const LIVE_CHART_ARCHIVE_WINDOW_SIZE = 5_000;

export interface LiveChartArchivePage {
  start: number;
  limit: number;
}

export interface LoadedLiveChartArchivePage extends LiveChartArchivePage {
  window: StudyResultScalarWindow;
}

function sameSeries(left: StudyResultSeriesIdentity, right: StudyResultSeriesIdentity): boolean {
  return left.run_id === right.run_id && left.task_id === right.task_id &&
    left.step_id === right.step_id && left.case_id === right.case_id &&
    left.attempt_id === right.attempt_id && left.ownership_epoch === right.ownership_epoch;
}

export function latestCompletedLiveChartStageId(
  execution: StageExecutionResource | null,
): string | null {
  if (!execution || execution.runtime_state !== "completed" || execution.completed_stage_indexes.length === 0) {
    return null;
  }
  const latestIndex = Math.max(...execution.completed_stage_indexes);
  const stage = execution.stages.find((candidate) => candidate.index === latestIndex);
  return stage?.status === "completed" && execution.stage_statuses[latestIndex] === "completed"
    ? stage.stage_id
    : null;
}

export function shouldLoadLiveChartArchivedTable(options: {
  active: boolean;
  paused: boolean;
  range: ChartRangePreference;
}): boolean {
  // Pause stops refreshes, but keeps the selected terminal series visible.
  return options.active && options.range.mode === "follow";
}

export function planLiveChartArchivePages(totalRows: number): LiveChartArchivePage[] {
  if (!Number.isSafeInteger(totalRows) || totalRows <= 1) return [];
  const rowCount = Math.min(totalRows, LIVE_CHART_ARCHIVE_WINDOW_SIZE);
  const windowStart = totalRows - rowCount;
  const pages: LiveChartArchivePage[] = [];
  for (let start = windowStart; start < totalRows;) {
    const limit = Math.min(LIVE_CHART_ARCHIVE_PAGE_SIZE, totalRows - start);
    pages.push({ start, limit });
    start += limit;
  }
  return pages;
}

export function mergeArchivedScalarPages({
  pages,
  probe,
  result,
  totalRows,
}: {
  pages: readonly LoadedLiveChartArchivePage[];
  probe: StudyResultScalarWindow;
  result: StudyStageResult;
  totalRows: number;
}): StudyResultScalarWindow | null {
  const plan = planLiveChartArchivePages(totalRows);
  if (plan.length === 0 || pages.length !== plan.length) return null;
  try {
    validateStudyResultScalars(probe, result);
  } catch {
    return null;
  }
  if (probe.coverage !== "solver_series" || probe.total_rows !== totalRows ||
      !/^(?:sha256:)?[a-f0-9]{64}$/i.test(probe.content_sha256)) {
    return null;
  }
  const rows: number[][] = [];
  for (const [index, loaded] of pages.entries()) {
    const expected = plan[index];
    const { window } = loaded;
    try {
      validateStudyResultScalars(window, result);
    } catch {
      return null;
    }
    if (!expected || loaded.start !== expected.start || loaded.limit !== expected.limit ||
        window.coverage !== "solver_series" || window.total_rows !== totalRows ||
        window.artifact_id !== probe.artifact_id ||
        window.content_sha256 !== probe.content_sha256 ||
        JSON.stringify(window.columns) !== JSON.stringify(probe.columns) ||
        window.rows.length !== Math.min(expected.limit, totalRows - expected.start) ||
        window.rows.some((row) => row.length !== probe.columns.length ||
          row.some((value) => !Number.isFinite(value)))) {
      return null;
    }
    rows.push(...window.rows);
  }
  if (rows.length !== Math.min(totalRows, LIVE_CHART_ARCHIVE_WINDOW_SIZE)) return null;
  return {
    series: probe.series,
    artifact_id: probe.artifact_id,
    content_sha256: probe.content_sha256,
    coverage: probe.coverage,
    total_rows: totalRows,
    columns: probe.columns,
    rows,
  };
}

export function selectLatestCompletedLiveChartResult({
  catalog,
  currentSeries,
  execution,
  sceneRevision,
}: {
  catalog: StudyStageResultsResource | null;
  currentSeries: StudyResultSeriesIdentity | null | undefined;
  execution: StageExecutionResource | null;
  sceneRevision: number | null;
}): StudyStageResult | null {
  const completedStageId = latestCompletedLiveChartStageId(execution);
  if (!catalog || !currentSeries || !execution || !completedStageId || sceneRevision === null ||
      catalog.scene_revision !== sceneRevision || currentSeries.run_id !== execution.run_id) {
    return null;
  }
  const authoredStageIds = new Set(catalog.authored_stage_ids);
  const matches = catalog.results.filter((result) => {
    const knownExecutionStage = execution.stages.find((stage) =>
      stage.stage_id === result.source.step_id || stage.stage_id === result.authored_stage_id,
    );
    if (knownExecutionStage && knownExecutionStage.stage_id !== completedStageId) return false;
    const authoredStageIsCurrent = result.authored_stage_id
      ? authoredStageIds.has(result.authored_stage_id)
      : result.source.step_id === completedStageId;
    return authoredStageIsCurrent && result.source.run_id === execution.run_id &&
      result.source.case_id === "default" && sameSeries(result.source, currentSeries);
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function archivedScalarWindowToChartTable({
  columns,
  limit,
  result,
  start,
  window,
}: {
  columns: readonly AxisColumnDescriptor[];
  limit: number;
  result: StudyStageResult;
  start: number;
  window: StudyResultScalarWindow;
}): ChartTableWindow | null {
  try {
    validateStudyResultScalars(window, result);
  } catch {
    return null;
  }
  if (window.coverage !== "solver_series" || !Number.isSafeInteger(window.total_rows) ||
      window.total_rows <= 1 || !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > LIVE_CHART_ARCHIVE_WINDOW_SIZE ||
      start + window.rows.length !== window.total_rows ||
      window.rows.length !== Math.min(limit, window.total_rows - start) || window.rows.length <= 1 ||
      !/^(?:sha256:)?[a-f0-9]{64}$/i.test(window.content_sha256)) {
    return null;
  }

  const availableColumns = new Map(columns.map((column) => [column.column_id, column]));
  const selected = window.columns.flatMap((sourceId, sourceIndex) => {
    const columnId = sourceId === "time" && availableColumns.has("t") ? "t" : sourceId;
    const descriptor = availableColumns.get(columnId);
    return descriptor ? [{ descriptor, sourceIndex }] : [];
  });
  const selectedColumnIds = new Set(selected.map(({ descriptor }) => descriptor.column_id));
  if (selected.length < 2 || selectedColumnIds.size !== selected.length) {
    return null;
  }
  if (window.rows.some((row) => row.length !== window.columns.length ||
      row.some((value) => !Number.isFinite(value)))) {
    return null;
  }

  const values = new Float64Array(window.rows.length * selected.length);
  window.rows.forEach((row, rowIndex) => {
    selected.forEach(({ sourceIndex }, columnIndex) => {
      values[rowIndex * selected.length + columnIndex] = row[sourceIndex]!;
    });
  });
  const identity = result.source;
  return {
    columnCount: selected.length,
    columns: selected.map(({ descriptor }) => descriptor),
    cursorEnd: window.total_rows,
    cursorStart: start + 1,
    resyncRequired: false,
    revision: window.total_rows,
    rowCount: window.rows.length,
    schemaRevision: 1,
    seriesRevision: JSON.stringify([
      identity.run_id, identity.task_id, identity.step_id, identity.case_id,
      identity.attempt_id, identity.ownership_epoch, result.artifact_id,
      result.artifact_sha256, window.artifact_id,
      window.content_sha256, start,
    ]),
    tableId: "default",
    totalRows: window.total_rows,
    values,
  };
}
