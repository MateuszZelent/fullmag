import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type { AnalysisChartResourceRef } from "./chartCursorPoint";

export interface ChartPoint {
  branchId?: string | null;
  itemId?: string | null;
  label?: string | null;
  linewidthHz?: number | null;
  rowIndex: number;
  sampleId?: string | null;
  x: number;
  y: number;
}

export interface ChartSeriesSourceIdentity {
  artifactPath: string | null;
  backend: string | null;
  contentDigest: string | null;
  device: string | null;
  precision: string | null;
  provenance: string | null;
  qualification: string;
  runId: string | null;
  schemaVersion: string | null;
  stageId: string | null;
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
  sourceIdentity?: ChartSeriesSourceIdentity;
  status: ResourceStatus;
  unit: string;
  xUnit: string;
}
