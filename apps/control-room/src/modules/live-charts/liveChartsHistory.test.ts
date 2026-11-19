import { describe, expect, it } from "vitest";

import type {
  StageExecutionResource,
  StudyResultScalarWindow,
  StudyResultSeriesIdentity,
  StudyStageResult,
  StudyStageResultsResource,
} from "@/kernel/api/apiTypes";
import {
  archivedScalarWindowToChartTable,
  mergeArchivedScalarPages,
  planLiveChartArchivePages,
  shouldLoadLiveChartArchivedTable,
  selectLatestCompletedLiveChartResult,
} from "./liveChartsHistory";

const currentIdentity: StudyResultSeriesIdentity = {
  run_id: "run-1",
  task_id: "task-b1",
  step_id: "B1",
  case_id: "default",
  attempt_id: "attempt-b1",
  ownership_epoch: 4,
};

function result(source: StudyResultSeriesIdentity = currentIdentity): StudyStageResult {
  return {
    project_id: "project-1",
    study_id: "study-1",
    source,
    authored_stage_id: "B1",
    artifact_id: "final-state-b1",
    artifact_sha256: "a".repeat(64),
    codec_id: "test-codec",
    codec_version: "1",
    accepted_at: "2026-11-19T00:00:00Z",
    authored_relation: "matching_authored_input",
    supports_magnetization_input: true,
  };
}

const execution: StageExecutionResource = {
  completed_stage_indexes: [0],
  request_scope_epoch: "scope-1",
  revision: 9,
  run_id: "run-1",
  runtime_state: "completed",
  session_epoch: "session-1@epoch-1",
  session_id: "session-1",
  stage_statuses: ["completed"],
  stages: [{ stage_id: "B1", index: 0, status: "completed", converged: true }],
  total_stages: 1,
};

function catalog(results: StudyStageResult[]): StudyStageResultsResource {
  return {
    revision: "revision-1",
    project_id: "project-1",
    scene_revision: 3,
    authored_input_sha256: null,
    authored_stage_ids: ["B1"],
    results,
    next_cursor: null,
  };
}

describe("Live Charts archived scalar history", () => {
  it("keeps a loaded follow archive available while the chart is paused", () => {
    expect(shouldLoadLiveChartArchivedTable({
      active: true,
      paused: true,
      range: { mode: "follow" },
    })).toBe(true);
    expect(shouldLoadLiveChartArchivedTable({
      active: true,
      paused: true,
      range: { mode: "fixed", fromSI: 0, toSI: 1 },
    })).toBe(false);
  });

  it("keeps a 5000-row terminal window within three bounded archive pages", () => {
    const totalRows = 100_001;
    const pages = planLiveChartArchivePages(totalRows);
    expect(pages).toEqual([
      { start: 95_001, limit: 2_048 },
      { start: 97_049, limit: 2_048 },
      { start: 99_097, limit: 904 },
    ]);

    const archivedPages = pages.map(({ limit, start }) => ({
      limit,
      start,
      window: {
        series: currentIdentity,
        artifact_id: "scalar-index-b1",
        content_sha256: "d".repeat(64),
        coverage: "solver_series" as const,
        total_rows: totalRows,
        columns: ["step", "time", "mx", "my", "mz"],
        rows: Array.from({ length: limit }, (_, offset) => {
          const step = start + offset + 1;
          return [step, step * 1e-12, step, step + 1, step + 2];
        }),
      } satisfies StudyResultScalarWindow,
    }));
    const probe: StudyResultScalarWindow = {
      series: currentIdentity,
      artifact_id: "scalar-index-b1",
      content_sha256: "d".repeat(64),
      coverage: "solver_series",
      total_rows: totalRows,
      columns: ["step", "time", "mx", "my", "mz"],
      rows: [[1, 1e-12, 1, 2, 3]],
    };
    const merged = mergeArchivedScalarPages({
      pages: archivedPages,
      probe,
      result: result(),
      totalRows,
    });
    const table = merged && archivedScalarWindowToChartTable({
      columns: [
        { column_id: "step", label: "Step", unit: "1" },
        { column_id: "t", label: "Time", unit: "s" },
        { column_id: "mx", label: "Mx", unit: "1" },
        { column_id: "my", label: "My", unit: "1" },
        { column_id: "mz", label: "Mz", unit: "1" },
      ],
      limit: 5_000,
      result: result(),
      start: 95_001,
      window: merged,
    });

    expect(table).toMatchObject({ cursorStart: 95_002, cursorEnd: totalRows, rowCount: 5_000, totalRows });
    expect(table?.values[0]).toBe(95_002);
    expect(table?.values[(5_000 - 1) * 5]).toBe(100_001);
  });

  it("selects only the current completed run, final stage, default case and exact attempt", () => {
    const candidate = result();
    expect(selectLatestCompletedLiveChartResult({
      catalog: catalog([candidate]),
      currentSeries: currentIdentity,
      execution,
      sceneRevision: 3,
    })).toBe(candidate);

    expect(selectLatestCompletedLiveChartResult({
      catalog: catalog([candidate]),
      currentSeries: { ...currentIdentity, attempt_id: "attempt-a1" },
      execution,
      sceneRevision: 3,
    })).toBeNull();
    expect(selectLatestCompletedLiveChartResult({
      catalog: { ...catalog([candidate]), authored_stage_ids: ["another-stage"] },
      currentSeries: currentIdentity,
      execution,
      sceneRevision: 3,
    })).toBeNull();
    expect(selectLatestCompletedLiveChartResult({
      catalog: { ...catalog([candidate]), scene_revision: 2 },
      currentSeries: currentIdentity,
      execution,
      sceneRevision: 3,
    })).toBeNull();
    expect(selectLatestCompletedLiveChartResult({
      catalog: catalog([candidate]),
      currentSeries: currentIdentity,
      execution: { ...execution, runtime_state: "running" },
      sceneRevision: 3,
    })).toBeNull();
    expect(selectLatestCompletedLiveChartResult({
      catalog: catalog([candidate, result({ ...currentIdentity, case_id: "case-2" })]),
      currentSeries: currentIdentity,
      execution,
      sceneRevision: 3,
    })).toBe(candidate);
  });

  it("matches StudyPlan V4 results by physical source when durable and authored IDs differ", () => {
    const physicalSeries = {
      ...currentIdentity,
      step_id: "script-execution-b1",
    };
    const candidate = {
      ...result(physicalSeries),
      authored_stage_id: "authored-b1",
    };
    const durableExecution = {
      ...execution,
      stages: [{ stage_id: "durable-b1", index: 0, status: "completed", converged: true }],
    };
    const authoredCatalog = {
      ...catalog([candidate]),
      authored_stage_ids: ["authored-b1"],
    };

    expect(selectLatestCompletedLiveChartResult({
      catalog: authoredCatalog,
      currentSeries: physicalSeries,
      execution: durableExecution,
      sceneRevision: 3,
    })).toBe(candidate);
  });

  it("rejects a page from a stale archive index even when the series identity matches", () => {
    const totalRows = 3;
    const probe: StudyResultScalarWindow = {
      series: currentIdentity,
      artifact_id: "scalar-index-current",
      content_sha256: "d".repeat(64),
      coverage: "solver_series",
      total_rows: totalRows,
      columns: ["step", "mx"],
      rows: [[1, 0.1]],
    };
    const stalePage: StudyResultScalarWindow = {
      ...probe,
      artifact_id: "scalar-index-stale",
      rows: [[1, 0.1], [2, 0.2], [3, 0.3]],
    };

    expect(mergeArchivedScalarPages({
      pages: [{ start: 0, limit: 3, window: stalePage }],
      probe,
      result: result(),
      totalRows,
    })).toBeNull();
  });

  it("uses the final bounded archive page after a fresh one-row live buffer", () => {
    const totalRows = 100_001;
    const start = totalRows - 3;
    const archived: StudyResultScalarWindow = {
      series: currentIdentity,
      artifact_id: "scalar-index-b1",
      content_sha256: "b".repeat(64),
      coverage: "solver_series",
      total_rows: totalRows,
      columns: ["step", "time", "mx", "my", "mz"],
      rows: [
        [99_999, 9.9999e-8, 0.1, 0.2, 0.3],
        [100_000, 1e-7, 0.2, 0.3, 0.4],
        [100_001, 1.00001e-7, 0.3, 0.4, 0.5],
      ],
    };
    const table = archivedScalarWindowToChartTable({
      columns: [
        { column_id: "step", label: "Step", unit: "1", dimension: "count" },
        { column_id: "t", label: "Time", unit: "s", dimension: "time" },
        { column_id: "mx", label: "Mx", unit: "1", dimension: "dimensionless" },
        { column_id: "my", label: "My", unit: "1", dimension: "dimensionless" },
        { column_id: "mz", label: "Mz", unit: "1", dimension: "dimensionless" },
      ],
      limit: 3,
      result: result(),
      start,
      window: archived,
    });

    expect(table).toMatchObject({ cursorStart: 99_999, cursorEnd: totalRows, rowCount: 3, totalRows });
    expect(table?.columns.map((column) => column.column_id)).toEqual(["step", "t", "mx", "my", "mz"]);
    expect(Array.from(table?.values ?? [])).toEqual(archived.rows.flat());
    expect(table?.seriesRevision).toContain("final-state-b1");
  });

  it("rejects archived rows pinned to a stale attempt or a non-final page", () => {
    const final = result();
    const stale = {
      series: { ...currentIdentity, attempt_id: "attempt-a1" },
      artifact_id: "scalar-index-a1",
      content_sha256: "c".repeat(64),
      coverage: "solver_series",
      total_rows: 3,
      columns: ["step", "time", "mx"],
      rows: [[1, 1, 0.1], [2, 2, 0.2], [3, 3, 0.3]],
    } satisfies StudyResultScalarWindow;
    const columns = [
      { column_id: "step", label: "Step", unit: "1" },
      { column_id: "t", label: "Time", unit: "s" },
      { column_id: "mx", label: "Mx", unit: "1" },
    ];

    expect(archivedScalarWindowToChartTable({ columns, limit: 3, result: final, start: 0, window: stale })).toBeNull();
    expect(archivedScalarWindowToChartTable({
      columns,
      limit: 2,
      result: final,
      start: 0,
      window: { ...stale, series: currentIdentity },
    })).toBeNull();
  });
});
