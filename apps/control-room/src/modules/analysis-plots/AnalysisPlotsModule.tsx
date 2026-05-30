"use client";

import {
  useScalarWindowResource,
  useSolverEnergyHistoryResource,
} from "@/kernel/resources/studyRuntimeResources";

import {
  ANALYSIS_PLOT_VIEWBOX,
  buildLineChartModel,
  type LinePoint,
} from "./analysisPlotModel";

export default function AnalysisPlotsModule() {
  const energyHistory = useSolverEnergyHistoryResource(240);
  const scalarWindow = useScalarWindowResource({
    columns: ["step", "e_total", "mx", "my", "mz"],
    limit: 240,
  });
  const energyPoints =
    energyHistory.data?.rows.map((row) => ({
      x: row.step,
      y: row.total,
    })) ?? [];
  const scalarPoints = scalarPointsFromWindow(scalarWindow.data);

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
  const model = buildLineChartModel(points);
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
  for (const preferred of preferredColumns) {
    const index = columns.indexOf(preferred);
    if (index >= 0) return index;
  }

  return columns.findIndex(
    (column) => !["step", "time", "solver_dt"].includes(column),
  );
}

export const __analysisPlotsTestUtils = {
  resolveScalarValueColumn,
  scalarPointsFromWindow,
};
