import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type { AnalysisChartResourceRef } from "./chartCursorPoint";

export interface ChartPoint {
  label?: string | null;
  linewidthHz?: number | null;
  rowIndex: number;
  x: number;
  y: number;
}

export interface ChartSeries {
  columnId?: string;
  component?: string | null;
  dataRevision?: string | number | null;
  dimension?: string;
  id: string;
  label: string;
  points: readonly ChartPoint[];
  quantity: string;
  reduction?: string | null;
  scope?: string;
  source: AnalysisChartResourceRef;
  status: ResourceStatus;
  unit: string;
  xUnit: string;
}
