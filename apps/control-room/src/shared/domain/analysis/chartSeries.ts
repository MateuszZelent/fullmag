import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type { AnalysisChartResourceRef } from "./chartCursorPoint";

export interface DispersionChartPointMetadata {
  analyticFrequencyHz?: number | null;
  branchId?: string | null;
  breakBefore?: boolean;
  frequencyHz?: number;
  itemId?: string | null;
  modeFieldAvailable?: boolean;
  modeFieldId?: string | null;
  modeFieldResourceKey?: string | null;
  modeId?: string | null;
  overlap?: number | null;
  pathS?: number;
  rawModeIndex?: number;
  relativeError?: number | null;
  residualNorm?: number | null;
  sampleId?: string | null;
  sampleIndex?: number;
  sampleLabel?: string | null;
  validationGeometry?: string | null;
  wavevectorKf?: readonly [number, number, number] | null;
}

export interface ChartPoint extends DispersionChartPointMetadata {
  label?: string | null;
  linewidthHz?: number | null;
  rowIndex: number;
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
  hasCompleteWavevectorKf?: boolean;
  kind?: "line" | "scatter";
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
