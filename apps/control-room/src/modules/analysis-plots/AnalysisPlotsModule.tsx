"use client";

import { useMemo } from "react";

import {
  shouldLoadRuntimeScalars,
  useScalarWindowResource,
  useSolverEnergyHistoryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import {
  ANALYSIS_PLOT_VIEWBOX,
  buildLineChartModel,
  type LinePoint,
} from "./analysisPlotModel";

const ANALYSIS_SCALAR_COLUMNS = Object.freeze([
  "step",
  "e_total",
  "mx",
  "my",
  "mz",
]);

export default function AnalysisPlotsModule() {
  const scalarsRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scalars_revision ?? null,
  );
  const loadScalars = shouldLoadRuntimeScalars(
    true,
    scalarsRevision === null
      ? null
      : { resources: { scalars_revision: scalarsRevision } },
  );
  const energyHistory = useSolverEnergyHistoryResource(240, {
    enabled: loadScalars,
  });
  const scalarWindow = useScalarWindowResource({
    columns: ANALYSIS_SCALAR_COLUMNS,
    enabled: loadScalars,
    limit: 240,
  });
  const energyPoints = useMemo(
    () => energyHistory.data?.rows.map((row) => ({
      x: row.step,
      y: row.total,
    })) ?? [],
    [energyHistory.data],
  );
  const scalarPoints = useMemo(
    () => scalarPointsFromWindow(scalarWindow.data),
    [scalarWindow.data],
  );

  return (
    <div className="fm-analysis-plots">
      <AnalysisPlotCard
        emptyLabel="No solver energy history"
        points={energyPoints}
        title="Energy"
        xLabel="step"
        yLabel="total"
      />
      <AnalysisPlotCard
        emptyLabel="No scalar samples"
        points={scalarPoints.points}
        title={scalarPoints.title}
        xLabel="step"
        yLabel={scalarPoints.yLabel}
      />
    </div>
  );
}

function AnalysisPlotCard({
  emptyLabel,
  points,
  title,
  xLabel,
  yLabel,
}: {
  emptyLabel: string;
  points: readonly LinePoint[];
  title: string;
  xLabel: string;
  yLabel: string;
}) {
  const model = useMemo(() => buildLineChartModel(points), [points]);
  return (
    <section className="fm-analysis-plots__panel">
      <header className="fm-analysis-plots__header">
        <h3>{title}</h3>
        <span>
          {xLabel} / {yLabel}
        </span>
      </header>
      {model ? (
        <svg
          aria-label={title}
          className="fm-analysis-plots__chart"
          preserveAspectRatio="none"
          viewBox={ANALYSIS_PLOT_VIEWBOX}
        >
          <path className="fm-analysis-plots__grid" d="M12 12 V128 M12 128 H308" />
          <path className="fm-analysis-plots__line" d={model.path} />
        </svg>
      ) : (
        <div className="fm-analysis-plots__empty">{emptyLabel}</div>
      )}
      <footer className="fm-analysis-plots__range">
        {model ? (
          <>
            <span>{formatNumber(model.xMin)}</span>
            <span>{formatNumber(model.yMin)}</span>
            <span>{formatNumber(model.xMax)}</span>
            <span>{formatNumber(model.yMax)}</span>
          </>
        ) : null}
      </footer>
    </section>
  );
}

function scalarPointsFromWindow(data: {
  columns: string[];
  rows: number[][];
} | null): {
  points: LinePoint[];
  title: string;
  yLabel: string;
} {
  const columns = data?.columns ?? [];
  const valueColumn = resolveScalarValueColumn(columns);
  if (!data || valueColumn < 0) {
    return { points: [], title: "Scalars", yLabel: "value" };
  }
  const stepColumn = columns.indexOf("step");
  return {
    points: data.rows.map((row, index) => ({
      x: stepColumn >= 0 ? row[stepColumn] : index,
      y: row[valueColumn],
    })),
    title: "Scalars",
    yLabel: columns[valueColumn] ?? "value",
  };
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(2);
  }
  return value.toPrecision(4);
}

function resolveScalarValueColumn(columns: readonly string[]): number {
  const preferredColumns = ["e_total", "mx", "my", "mz"];
  const excludedColumns = new Set(["step", "time", "solver_dt"]);
  const columnIndexByName = new Map(
    columns.map((column, index) => [column, index]),
  );
  for (const preferred of preferredColumns) {
    const index = columnIndexByName.get(preferred) ?? -1;
    if (index >= 0) return index;
  }

  return columns.findIndex(
    (column) => !excludedColumns.has(column),
  );
}

export const __analysisPlotsTestUtils = {
  analysisScalarColumns: ANALYSIS_SCALAR_COLUMNS,
  resolveScalarValueColumn,
  scalarPointsFromWindow,
};
