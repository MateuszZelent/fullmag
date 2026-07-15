interface AnalysisChartPoint {
  label?: string | null;
  linewidthHz?: number | null;
  rowIndex: number;
  x: number;
  y: number;
}

export interface AnalysisChartResourceRef {
  kind:
    | "analysis.frequency_domain"
    | "analysis.spin_wave"
    | "data.table.rows"
    | "simulation.solver.energies.history";
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
