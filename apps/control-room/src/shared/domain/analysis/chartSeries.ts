import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type { AnalysisChartResourceRef } from "./chartCursorPoint";

/** Physical point metadata retained for dispersion inspection and projection. */
export interface DispersionChartPointMetadata {
  branchId?: string | null;
  itemId?: string | null;
  sampleId?: string | null;
  wavevectorRadPerM?: readonly [number, number, number] | null;
  sampleIndex?: number;
  modeIndex?: number;
  residualNorm?: number | null;
  selected?: boolean;
  modeFieldAvailable?: boolean;
}

export interface ChartPoint extends DispersionChartPointMetadata {
  breakBefore?: boolean;
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
  kind?: "line" | "scatter";
  showSymbols?: boolean;
  label: string;
  points: readonly ChartPoint[];
  quantity: string;
  reduction?: string | null;
  scope?: string;
  source: AnalysisChartResourceRef;
  sourceIdentity?: ChartSeriesSourceIdentity;
  status: ResourceStatus;
  unit: string;
  xAxisLabel?: string;
  xUnit: string;
}
