export interface AnalysisChartPoint {
  rowIndex: number;
  x: number;
  y: number;
}

export interface AnalysisChartResourceRef {
  kind: "data.table.rows" | "simulation.solver.energies.history";
  resourceKey: string;
  tableId: string;
}

export interface AnalysisChartCursorPoint {
  label: string;
  point: AnalysisChartPoint;
  quantity: string;
  seriesId: string;
  source: AnalysisChartResourceRef;
  unit: string;
  xUnit: string;
}
