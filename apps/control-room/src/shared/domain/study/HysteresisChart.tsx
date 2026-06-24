"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { ECharts, EChartsOption } from "echarts";

import type {
  HysteresisAngularFamilyResource,
  HysteresisMetricsSchema,
  HysteresisOrientationSchema,
  HysteresisPointSchema,
  HysteresisProgressSchema,
} from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { ModuleId } from "@/kernel/types";
import {
  useHysteresisBranchesResource,
  useHysteresisFamilyResource,
  useHysteresisMetricsResource,
  useHysteresisMinorLoopsResource,
  useHysteresisOrientationResource,
  useHysteresisPointsResource,
  useHysteresisProgressResource,
  useHysteresisProtocolResource,
  type HysteresisBranch,
  type HysteresisMinorLoop,
} from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import { ChevronLeft, ChevronRight, Pause, Play, ZoomOut } from "lucide-react";

interface HysteresisChartProps {
  commandSource?: CommandContext["source"];
  kernel: KernelApi;
  stageId: string;
}

export interface HysteresisTargetMetadata {
  fieldOrientation?: string | null;
  fieldRevision?: string | number | null;
  measurementAxis?: string | null;
  meshIdentity?: string | null;
}

export type YAxisKey =
  | "m_parallel"
  | "m_oop"
  | "m_ip"
  | "m_avg_x"
  | "m_avg_y"
  | "m_avg_z";
type XAxisUnit = "mT" | "kA/m";
type ViewMode = "full" | "virgin" | "forward" | "return" | "minor" | "oop-ip-overlay" | "rgb-overlay" | "angular-family";
type ChartDataPoint = [number, number, number];
interface HysteresisChartLineSeriesModel {
  branchId: string | null;
  data: ChartDataPoint[];
  name: string;
}

interface HysteresisChartOverlayComponent {
  id: string;
  name: string;
  yAxisKey: YAxisKey;
}

export type HysteresisMetricMarkerKind =
  | "adaptive"
  | "coercivity"
  | "remanence"
  | "reversal"
  | "saturation"
  | "switching-candidate"
  | "warning";

export interface HysteresisMetricMarkerModel {
  fieldValueMt: number;
  kind: HysteresisMetricMarkerKind;
  label: string;
  pointId: number | null;
  value: number | null;
  x: number;
}

const HYSTERESIS_METRIC_MARKER_ORDER = new Map<HysteresisMetricMarkerKind, number>([
  ["coercivity", 0],
  ["remanence", 1],
  ["saturation", 2],
  ["switching-candidate", 3],
  ["reversal", 4],
  ["adaptive", 5],
  ["warning", 6],
]);

const EMPTY_HYSTERESIS_POINTS: HysteresisPointSchema[] = [];
const EMPTY_HYSTERESIS_BRANCHES: HysteresisBranch[] = [];
const EMPTY_HYSTERESIS_MINOR_LOOPS: HysteresisMinorLoop[] = [];
export const HYSTERESIS_CHART_VALUE_AXIS_SCALE = true;

function progressPointIndex(
  progress: HysteresisProgressSchema | null | undefined,
): number | null {
  const index = progress?.active_point_index ?? progress?.current_point_index;
  return typeof index === "number" ? index : null;
}

function progressSettleLabel(
  progress: HysteresisProgressSchema | null | undefined,
): string | null {
  const kind = progress?.current_settle_step_kind;
  const method = progress?.current_settle_step_method;
  if (kind && method) return `${kind} ${method}`;
  return kind ?? method ?? null;
}

export function selectedHysteresisPointId(
  selection: Selection,
  stageId: string,
): number | null {
  const ref = selection.ref;
  if (
    ref?.type !== "analysis-chart-point" ||
    ref.stageId !== stageId ||
    typeof ref.pointId !== "number"
  ) {
    return null;
  }
  return ref.pointId;
}

export function resolveHysteresisChartPointById(
  points: readonly HysteresisPointSchema[],
  branches: readonly HysteresisBranch[],
  minorLoops: readonly HysteresisMinorLoop[],
  pointId: number,
): HysteresisPointSchema | null {
  return points.find((point) => point.point_id === pointId)
    ?? branches.flatMap((branch) => branch.points).find((point) => point.point_id === pointId)
    ?? minorLoops.flatMap((loop) => loop.points).find((point) => point.point_id === pointId)
    ?? null;
}

export function clearHysteresisPointSelectionForLive(
  kernel: Pick<KernelApi, "selection">,
  stageId: string,
  source: ModuleId,
): boolean {
  const ref = kernel.selection.get().ref;
  if (
    !(
      (ref?.type === "analysis-chart-point" || ref?.type === "hysteresis-snapshot") &&
      ref.stageId === stageId
    )
  ) {
    return false;
  }
  kernel.selection.clear(source);
  return true;
}

export function resolveHysteresisNavigationIndex(
  activeIndex: number,
  progressIndex: number | null,
  pointCount: number,
): number {
  if (pointCount <= 0) return -1;
  if (activeIndex >= 0 && activeIndex < pointCount) return activeIndex;
  if (progressIndex != null && progressIndex >= 0 && progressIndex < pointCount) {
    return progressIndex;
  }
  return -1;
}

export function adjacentHysteresisPointIndex(
  activeIndex: number,
  progressIndex: number | null,
  pointCount: number,
  delta: -1 | 1,
): number {
  if (pointCount <= 0) return -1;
  const base = resolveHysteresisNavigationIndex(activeIndex, progressIndex, pointCount);
  if (base < 0) return 0;
  return Math.min(Math.max(base + delta, 0), pointCount - 1);
}

export function nextHysteresisPlaybackIndex(
  activeIndex: number,
  progressIndex: number | null,
  pointCount: number,
): number {
  if (pointCount <= 0) return -1;
  const base = resolveHysteresisNavigationIndex(activeIndex, progressIndex, pointCount);
  return base < 0 ? 0 : (base + 1) % pointCount;
}

export function resolveHysteresisKeyboardNavigationIndex(
  key: string,
  activeIndex: number,
  progressIndex: number | null,
  pointCount: number,
): number | null {
  if (pointCount <= 0) return null;
  if (key === "ArrowRight") {
    return adjacentHysteresisPointIndex(activeIndex, progressIndex, pointCount, 1);
  }
  if (key === "ArrowLeft") {
    return adjacentHysteresisPointIndex(activeIndex, progressIndex, pointCount, -1);
  }
  return null;
}

export function resolveHysteresisScrubberPointIndex(
  value: number | string,
  pointCount: number,
): number | null {
  if (pointCount <= 0) return null;
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.min(Math.max(Math.round(numericValue), 0), pointCount - 1);
}

interface ChartClickParams {
  componentType?: unknown;
  data?: unknown;
}

interface TooltipParam {
  data?: unknown;
  seriesId?: unknown;
  seriesName?: unknown;
}

interface HysteresisChartColors {
  active: string;
  axis: string;
  border: string;
  branchDescending: string;
  branchAscending: string;
  metric: string;
  remanence: string;
  surface: string;
  text: string;
  textMuted: string;
}

function isChartDataPoint(value: unknown): value is ChartDataPoint {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

export function formatHysteresisChartTooltip(
  params: unknown,
  {
    branchMode,
    points,
    xAxisUnit,
  }: {
    branchMode?: string | null;
    points: readonly HysteresisPointSchema[];
    xAxisUnit: XAxisUnit;
  },
): string {
  let result = "";
  const entries = Array.isArray(params)
    ? (params as TooltipParam[])
    : [params as TooltipParam];
  entries.forEach((entry) => {
    if (!isChartDataPoint(entry.data)) return;
    const pointId = entry.data[2];
    const matchedPoint = points.find((point) => point.point_id === pointId);
    const branchId = hysteresisBranchIdFromSeriesId(entry.seriesId);
    const seriesName =
      typeof entry.seriesName === "string" ? entry.seriesName : null;
    result += `<div style="font-weight: bold; margin-bottom: 4px;">Point ID: ${pointId}</div>`;
    if (branchMode) {
      result += `<div>Protocol: ${branchMode}</div>`;
    }
    if (branchId) {
      result += `<div>Branch: ${branchId}</div>`;
    }
    if (seriesName) {
      result += `<div>Series: ${seriesName}</div>`;
    }
    result += `<div>H: ${entry.data[0].toFixed(2)} ${xAxisUnit}</div>`;
    result += `<div>M: ${entry.data[1].toFixed(5)}</div>`;
    if (matchedPoint?.snapshot_id) {
      result += `<div>Snapshot available</div>`;
    }
  });
  return result;
}

function hysteresisBranchIdFromSeriesId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const separatorIndex = value.indexOf(":");
  if (separatorIndex >= 0 && separatorIndex < value.length - 1) {
    return value.slice(separatorIndex + 1);
  }
  if (
    value === "ascending" ||
    value === "descending" ||
    value.startsWith("minor_loop")
  ) {
    return value;
  }
  return null;
}

function isViewMode(value: string): value is ViewMode {
  return value === "full" || value === "virgin" || value === "forward" || value === "return" || value === "minor" || value === "oop-ip-overlay" || value === "rgb-overlay" || value === "angular-family";
}

function getPointYValue(p: HysteresisPointSchema, key: YAxisKey): number {
  switch (key) {
    case "m_parallel":
      return p.m_parallel;
    case "m_oop":
      return p.m_oop;
    case "m_ip":
      return p.m_ip;
    case "m_avg_x":
      return p.m_avg[0] ?? 0;
    case "m_avg_y":
      return p.m_avg[1] ?? 0;
    case "m_avg_z":
      return p.m_avg[2] ?? 0;
  }
}

function uniqueHysteresisPointsById(
  points: HysteresisPointSchema[],
): HysteresisPointSchema[] {
  const seen = new Set<number>();
  const unique: HysteresisPointSchema[] = [];
  points.forEach((point) => {
    if (seen.has(point.point_id)) return;
    seen.add(point.point_id);
    unique.push(point);
  });
  return unique;
}

function leadingMonotonicHysteresisPoints(
  points: HysteresisPointSchema[],
): HysteresisPointSchema[] {
  if (points.length <= 2) return points;
  const selected = [points[0]];
  let direction = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const delta = current.field_value_mT - previous.field_value_mT;
    const currentDirection = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (currentDirection !== 0) {
      if (direction === 0) {
        direction = currentDirection;
      } else if (currentDirection !== direction) {
        break;
      }
    }
    selected.push(current);
  }
  return selected;
}

function visibleHysteresisChartPoints(
  points: HysteresisPointSchema[],
  branches: HysteresisBranch[],
  minorLoops: HysteresisMinorLoop[],
  viewMode: ViewMode,
  branchMode?: string | null,
): HysteresisPointSchema[] {
  if (viewMode === "virgin") {
    const sourcePoints = points.length > 0
      ? points
      : branches.flatMap((branch) => branch.points);
    return branchMode === "virgin_curve"
      ? sourcePoints
      : leadingMonotonicHysteresisPoints(sourcePoints);
  }
  if (viewMode === "minor") {
    return minorLoops.flatMap((loop) => loop.points);
  }
  if (
    viewMode === "full" ||
    viewMode === "oop-ip-overlay" ||
    viewMode === "rgb-overlay"
  ) {
    return points.length > 0
      ? points
      : branches.flatMap((branch) => branch.points);
  }
  const filteredBranches = branches.filter((branch) => {
    if (viewMode === "forward") return branch.branch_id === "ascending";
    if (viewMode === "return") return branch.branch_id === "descending";
    return true;
  });
  return filteredBranches.length > 0 ? filteredBranches.flatMap((branch) => branch.points) : [];
}

export function buildHysteresisAdaptivePointMarkerModel(
  points: HysteresisPointSchema[],
  branches: HysteresisBranch[],
  minorLoops: HysteresisMinorLoop[],
  viewMode: ViewMode,
  yAxisKey: YAxisKey,
  formatXValue: (fieldValmT: number) => number = (fieldValmT) => fieldValmT,
  branchMode?: string | null,
): ChartDataPoint[] {
  return uniqueHysteresisPointsById(
    visibleHysteresisChartPoints(points, branches, minorLoops, viewMode, branchMode),
  ).flatMap((point) =>
    point.adaptive_inserted === true
      ? [
          [
            formatXValue(point.field_value_mT),
            getPointYValue(point, yAxisKey),
            point.point_id,
          ],
        ]
      : [],
  );
}

export function buildHysteresisMetricMarkerModel({
  formatXValue = (fieldValueMt) => fieldValueMt,
  metrics,
  points,
  yAxisKey,
}: {
  formatXValue?: (fieldValueMt: number) => number;
  metrics: HysteresisMetricsSchema | null | undefined;
  points: readonly HysteresisPointSchema[];
  yAxisKey: YAxisKey;
}): HysteresisMetricMarkerModel[] {
  const markers: HysteresisMetricMarkerModel[] = [];
  const pushFieldMarker = (
    kind: HysteresisMetricMarkerKind,
    label: string,
    fieldValueMt: number | null | undefined,
    value: number | null,
    pointId: number | null,
  ) => {
    if (typeof fieldValueMt !== "number" || !Number.isFinite(fieldValueMt)) {
      return;
    }
    markers.push({
      fieldValueMt,
      kind,
      label,
      pointId,
      value,
      x: formatXValue(fieldValueMt),
    });
  };

  if (metrics) {
    pushFieldMarker("coercivity", "Hc+", metrics.H_c_plus, 0, null);
    pushFieldMarker("coercivity", "Hc-", metrics.H_c_minus, 0, null);
    pushFieldMarker("remanence", "Mr+", 0, metrics.M_r_plus ?? null, null);
    pushFieldMarker("remanence", "Mr-", 0, metrics.M_r_minus ?? null, null);
    pushFieldMarker(
      "saturation",
      "Hsat",
      metrics.saturation_preparation_field_mT,
      null,
      null,
    );
    const pointById = new Map(points.map((point) => [point.point_id, point]));
    for (const candidate of metrics.switching_field_candidates ?? []) {
      const point =
        pointById.get(candidate.point_id_after) ??
        pointById.get(candidate.point_id_before) ??
        null;
      pushFieldMarker(
        "switching-candidate",
        "Switch candidate",
        candidate.field_value_mT,
        point ? getPointYValue(point, yAxisKey) : null,
        point?.point_id ?? null,
      );
    }
  }

  for (const point of points) {
    const value = getPointYValue(point, yAxisKey);
    if (point.is_reversal_field) {
      pushFieldMarker("reversal", "Reversal", point.field_value_mT, value, point.point_id);
    }
    if (point.adaptive_inserted) {
      pushFieldMarker("adaptive", "Adaptive", point.field_value_mT, value, point.point_id);
    }
    if (point.has_non_converged_steps || String(point.status).toLowerCase() === "warning") {
      pushFieldMarker("warning", "Warning", point.field_value_mT, value, point.point_id);
    }
  }

  return markers.toSorted(
    (left, right) =>
      (HYSTERESIS_METRIC_MARKER_ORDER.get(left.kind) ?? 99) -
      (HYSTERESIS_METRIC_MARKER_ORDER.get(right.kind) ?? 99),
  );
}

export function buildHysteresisChartLineSeriesModel(
  points: HysteresisPointSchema[],
  branches: HysteresisBranch[],
  minorLoops: HysteresisMinorLoop[],
  viewMode: ViewMode,
  yAxisKey: YAxisKey,
  formatXValue: (fieldValmT: number) => number = (fieldValmT) => fieldValmT,
  branchMode?: string | null,
): HysteresisChartLineSeriesModel[] {
  if (viewMode === "virgin") {
    const sourcePoints = points.length > 0
      ? points
      : branches.flatMap((branch) => branch.points);
    const virginPoints = branchMode === "virgin_curve"
      ? sourcePoints
      : leadingMonotonicHysteresisPoints(sourcePoints);
    return virginPoints.length > 0
      ? [{
          branchId: "virgin",
          data: virginPoints.map((p) => [
            formatXValue(p.field_value_mT),
            getPointYValue(p, yAxisKey),
            p.point_id,
          ]),
          name: "Virgin",
        }]
      : [];
  }

  if (viewMode === "oop-ip-overlay") {
    return buildHysteresisComponentOverlaySeries(
      points,
      branches,
      [
        { id: "oop-overlay", name: "M_oop", yAxisKey: "m_oop" },
        { id: "ip-overlay", name: "M_ip", yAxisKey: "m_ip" },
      ],
      formatXValue,
    );
  }

  if (viewMode === "rgb-overlay") {
    return buildHysteresisComponentOverlaySeries(
      points,
      branches,
      [
        { id: "mx-overlay", name: "M_x", yAxisKey: "m_avg_x" },
        { id: "my-overlay", name: "M_y", yAxisKey: "m_avg_y" },
        { id: "mz-overlay", name: "M_z", yAxisKey: "m_avg_z" },
      ],
      formatXValue,
    );
  }

  if (viewMode === "minor") {
    return minorLoops.map((loop) => ({
      branchId: loop.loop_id,
      data: loop.points.map((p) => [
        formatXValue(p.field_value_mT),
        getPointYValue(p, yAxisKey),
        p.point_id,
      ]),
      name: loop.loop_id,
    }));
  }

  const filteredBranches = branches.filter((b) => {
    if (viewMode === "forward") return b.branch_id === "ascending";
    if (viewMode === "return") return b.branch_id === "descending";
    return true;
  });

  if (filteredBranches.length === 0 && points.length > 0) {
    return [{
      branchId: null,
      data: points.map((p) => [
        formatXValue(p.field_value_mT),
        getPointYValue(p, yAxisKey),
        p.point_id,
      ]),
      name: "All points",
    }];
  }

  return filteredBranches.map((branch) => ({
    branchId: branch.branch_id,
    data: branch.points.map((p) => [
      formatXValue(p.field_value_mT),
      getPointYValue(p, yAxisKey),
      p.point_id,
    ]),
    name: branch.branch_id === "ascending"
      ? "Ascending (Forward)"
      : "Descending (Return)",
  }));
}

function buildHysteresisComponentOverlaySeries(
  points: HysteresisPointSchema[],
  branches: HysteresisBranch[],
  components: HysteresisChartOverlayComponent[],
  formatXValue: (fieldValmT: number) => number,
): HysteresisChartLineSeriesModel[] {
  const sources = branches.length > 0
    ? branches.map((branch) => ({
        branchId: branch.branch_id,
        name: hysteresisBranchSeriesName(branch.branch_id),
        points: branch.points,
      }))
    : [{ branchId: null, name: null, points }];

  return sources.flatMap((source) =>
    source.points.length > 0
      ? components.map((component) => ({
          branchId: source.branchId
            ? `${component.id}:${source.branchId}`
            : component.id,
          data: source.points.map((point) => [
            formatXValue(point.field_value_mT),
            getPointYValue(point, component.yAxisKey),
            point.point_id,
          ]),
          name: source.name
            ? `${component.name} ${source.name}`
            : component.name,
        }))
      : [],
  );
}

function hysteresisBranchSeriesName(branchId: string): string {
  if (branchId === "ascending") return "Ascending (Forward)";
  if (branchId === "descending") return "Descending (Return)";
  return branchId;
}

export function buildHysteresisAngularFamilyLineSeriesModel(
  family: HysteresisAngularFamilyResource | null | undefined,
  yAxisKey: YAxisKey,
  formatXValue: (fieldValmT: number) => number = (fieldValmT) => fieldValmT,
): HysteresisChartLineSeriesModel[] {
  const series = Array.isArray(family?.series) ? family.series : [];
  return series.flatMap((entry) =>
    Array.isArray(entry.points) && entry.points.length > 0
      ? [
          {
      branchId: `angular-family:${entry.variant_id}`,
      data: entry.points.map((p) => [
        formatXValue(p.field_value_mT),
        getPointYValue(p, yAxisKey),
        p.point_id,
      ]),
      name: entry.label ? `${entry.label} (${entry.variant_id})` : entry.variant_id,
          },
        ]
      : [],
  );
}

export function getProgressYValue(
  progress: HysteresisProgressSchema | null | undefined,
  key: YAxisKey,
): number | null {
  const mAvg = progress?.current_m_avg;
  if (!Array.isArray(mAvg) || mAvg.length < 3) {
    return key === "m_parallel" && typeof progress?.current_m_parallel === "number"
      ? progress.current_m_parallel
      : null;
  }
  switch (key) {
    case "m_parallel":
      return typeof progress?.current_m_parallel === "number"
        ? progress.current_m_parallel
        : null;
    case "m_oop":
      return mAvg[2] ?? null;
    case "m_ip": {
      const mx = mAvg[0] ?? 0;
      const my = mAvg[1] ?? 0;
      return Math.sqrt(mx * mx + my * my);
    }
    case "m_avg_x":
      return mAvg[0] ?? null;
    case "m_avg_y":
      return mAvg[1] ?? null;
    case "m_avg_z":
      return mAvg[2] ?? null;
  }
}

export function buildHysteresisChartPointSelection({
  includeSnapshot = true,
  point,
  stageId,
  targetMetadata = {},
  yAxisKey,
}: {
  includeSnapshot?: boolean;
  point: HysteresisPointSchema;
  stageId: string;
  targetMetadata?: HysteresisTargetMetadata;
  yAxisKey: YAxisKey;
}): Partial<Omit<Selection, "moduleSource">> {
  const chartId = `hysteresis:${stageId}`;
  const nodeId = `analysis:hysteresis:${stageId}:point:${point.point_id}`;
  const y = getPointYValue(point, yAxisKey);
  const pointTargetMetadata = hysteresisPointTargetMetadata(point, targetMetadata);
  const snapshotResourceRef = hysteresisPointVectorResourceRef(point);
  return {
    kind: "analysis.chart-point",
    label: `Hysteresis point ${point.point_id} (${point.field_value_mT} mT)`,
    nodeId,
    objectId: null,
    ref: {
      chartId,
      kind: "analysis.chart-point",
      nodeId,
      pointId: point.point_id,
      quantity: yAxisKey,
      rowIndex: point.point_id,
      seriesId: `${chartId}:${yAxisKey}`,
      ...(includeSnapshot
        ? {
            snapshotId: point.snapshot_id ?? null,
            resourceRef: snapshotResourceRef,
            targetId: `hysteresis-step:${stageId}:${point.point_id}`,
            targetKind: "hysteresis-step",
            quantityId: "m",
            meshIdentity: pointTargetMetadata.meshIdentity ?? null,
            fieldOrientation: pointTargetMetadata.fieldOrientation ?? null,
            measurementAxis: pointTargetMetadata.measurementAxis ?? null,
            fieldRevision: pointTargetMetadata.fieldRevision ?? null,
          }
        : {}),
      stageId,
      tableId: chartId,
      type: "analysis-chart-point",
      x: point.field_value_mT,
      y,
    },
  };
}

export function buildHysteresisLoadPointIn3DInput({
  point,
  stageId,
  targetMetadata = {},
  yAxisKey,
}: {
  point: HysteresisPointSchema;
  stageId: string;
  targetMetadata?: HysteresisTargetMetadata;
  yAxisKey: YAxisKey;
}) {
  const pointTargetMetadata = hysteresisPointTargetMetadata(point, targetMetadata);
  return {
    stageId,
    pointId: point.point_id,
    fieldVal: point.field_value_mT,
    mVal: getPointYValue(point, yAxisKey),
    snapshotId: point.snapshot_id ?? null,
    snapshotResourceRef: hysteresisPointVectorResourceRef(point),
    snapshotStorageStatus: point.snapshot_storage_status ?? null,
    snapshotStorageReason: point.snapshot_storage_reason ?? null,
    meshIdentity: pointTargetMetadata.meshIdentity ?? null,
    fieldOrientation: pointTargetMetadata.fieldOrientation ?? null,
    measurementAxis: pointTargetMetadata.measurementAxis ?? null,
    fieldRevision: pointTargetMetadata.fieldRevision ?? null,
  };
}

export function buildHysteresisSelectPointCommandInput({
  point,
  stageId,
  targetMetadata = {},
  yAxisKey,
}: {
  point: HysteresisPointSchema;
  stageId: string;
  targetMetadata?: HysteresisTargetMetadata;
  yAxisKey: YAxisKey;
}) {
  return buildHysteresisLoadPointIn3DInput({
    point,
    stageId,
    targetMetadata,
    yAxisKey,
  });
}

export function buildHysteresisUsePointAsInitialStateInput({
  point,
  stageId,
}: {
  point: HysteresisPointSchema;
  stageId: string;
}) {
  return {
    stageId,
    snapshotId: point.snapshot_id ?? null,
    snapshotArtifactRef: point.snapshot_json_artifact_ref ?? null,
    snapshotResourceRef: point.snapshot_resource_ref ?? null,
  };
}

export function hysteresisChartReplayActionPresentation(
  snapshotId?: string | null,
  snapshotStorageStatus?: string | null,
  snapshotStorageReason?: string | null,
): { disabled: boolean; title: string } {
  if (!snapshotId) {
    return {
      disabled: true,
      title: "Snapshot not saved for this point",
    };
  }
  if (snapshotStorageStatus === "missing") {
    return {
      disabled: true,
      title: snapshotStorageReason
        ? `Snapshot payload is missing for this point: ${snapshotStorageReason}`
        : "Snapshot payload is missing for this point",
    };
  }
  return {
    disabled: false,
    title: "Load point magnetization in 3D viewport",
  };
}

export function hysteresisChartInitialStateActionPresentation(
  snapshotId?: string | null,
  snapshotStorageStatus?: string | null,
  snapshotStorageReason?: string | null,
): { disabled: boolean; title: string } {
  if (!snapshotId) {
    return {
      disabled: true,
      title: "Snapshot not saved for this point",
    };
  }
  if (snapshotStorageStatus === "missing") {
    return {
      disabled: true,
      title: snapshotStorageReason
        ? `Snapshot payload is missing for this point: ${snapshotStorageReason}`
        : "Snapshot payload is missing for this point",
    };
  }
  return {
    disabled: false,
    title: "Use point magnetization as the initial state for the selected or only object",
  };
}

export function buildHysteresisChartDataZoomModel(
  colors: Pick<HysteresisChartColors, "axis" | "border" | "surface" | "textMuted">,
): EChartsOption["dataZoom"] {
  return [
    {
      type: "inside",
      filterMode: "none",
      start: 0,
      end: 100,
    },
    {
      type: "slider",
      filterMode: "none",
      bottom: 8,
      height: 12,
      showDetail: false,
      showDataShadow: false,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      fillerColor: colors.textMuted,
      handleSize: "100%",
      handleStyle: {
        color: colors.axis,
        borderWidth: 0,
      },
      start: 0,
      end: 100,
    },
  ];
}

export function resetHysteresisChartZoom(
  chart: Pick<ECharts, "dispatchAction"> | null,
): boolean {
  if (!chart) return false;
  chart.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
  return true;
}

export function hysteresisPointVectorResourceRef(
  point: HysteresisPointSchema,
): string | null {
  return point.snapshot_vector_resource_ref ?? point.snapshot_resource_ref ?? null;
}

export function hysteresisPointTargetMetadata(
  point: HysteresisPointSchema,
  fallback: HysteresisTargetMetadata = {},
): HysteresisTargetMetadata {
  return {
    fieldOrientation:
      stringifyHysteresisOrientation(point.field_orientation) ??
      fallback.fieldOrientation ??
      null,
    fieldRevision: fallback.fieldRevision ?? null,
    measurementAxis:
      stringifyHysteresisMeasurementAxis(point.measurement_axis) ??
      fallback.measurementAxis ??
      null,
    meshIdentity: fallback.meshIdentity ?? null,
  };
}

export function hysteresisTargetMetadataFromOrientation(
  orientation: HysteresisOrientationSchema | null | undefined,
): HysteresisTargetMetadata {
  if (!orientation) {
    return {
      fieldOrientation: null,
      fieldRevision: null,
      measurementAxis: null,
    };
  }
  return {
    fieldOrientation:
      stringifyHysteresisOrientation(orientation.orientation) ??
      stringifyHysteresisDirection(orientation.direction),
    fieldRevision: orientation.revision,
    measurementAxis: stringifyHysteresisMeasurementAxis(orientation.measurement_axis),
  };
}

function stringifyHysteresisMeasurementAxis(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyHysteresisOrientation(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyHysteresisDirection(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((component) => typeof component === "number")) return null;
  return `global(${value.map((component) => component.toPrecision(6)).join(",")})`;
}

function cssVar(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

function readHysteresisChartColors(element: HTMLElement): HysteresisChartColors {
  const styles = getComputedStyle(element);
  const text = cssVar(styles, "--fm-text-primary", styles.color);
  const textMuted = cssVar(styles, "--fm-text-muted", text);
  const accent = cssVar(styles, "--fm-accent", text);

  return {
    active: cssVar(styles, "--fm-hysteresis-active", accent),
    axis: cssVar(styles, "--fm-hysteresis-axis", textMuted),
    border: cssVar(styles, "--fm-border-subtle", textMuted),
    branchDescending: cssVar(styles, "--fm-hysteresis-branch-descending", accent),
    branchAscending: cssVar(styles, "--fm-hysteresis-branch-ascending", accent),
    metric: cssVar(styles, "--fm-hysteresis-metric", accent),
    remanence: cssVar(styles, "--fm-hysteresis-remanence", accent),
    surface: cssVar(styles, "--fm-bg-surface", "transparent"),
    text,
    textMuted,
  };
}

function formatHysteresisMetricMarkerValue(marker: HysteresisMetricMarkerModel): string {
  switch (marker.kind) {
    case "coercivity":
    case "saturation":
    case "switching-candidate":
    case "reversal":
    case "adaptive":
    case "warning":
      return `${marker.label}: ${marker.fieldValueMt.toFixed(1)} mT`;
    case "remanence":
      return marker.value == null
        ? marker.label
        : `${marker.label}: ${marker.value.toFixed(3)}`;
  }
}

function hysteresisMetricMarkerColor(
  kind: HysteresisMetricMarkerKind,
  colors: HysteresisChartColors,
): string {
  switch (kind) {
    case "coercivity":
    case "saturation":
    case "switching-candidate":
      return colors.metric;
    case "remanence":
      return colors.remanence;
    case "adaptive":
      return colors.active;
    case "reversal":
      return colors.branchAscending;
    case "warning":
      return colors.branchDescending;
  }
}

export function HysteresisChart(props: HysteresisChartProps) {
  return useHysteresisChartView(props);
}

function useHysteresisChartView({
  commandSource = "analysis-plots",
  kernel,
  stageId,
}: HysteresisChartProps) {
  const pointsRes = useHysteresisPointsResource(stageId);
  const branchesRes = useHysteresisBranchesResource(stageId);
  const familyRes = useHysteresisFamilyResource(stageId);
  const minorLoopsRes = useHysteresisMinorLoopsResource(stageId);
  const metricsRes = useHysteresisMetricsResource(stageId);
  const orientationRes = useHysteresisOrientationResource(stageId);
  const progressRes = useHysteresisProgressResource(stageId);
  const protocolRes = useHysteresisProtocolResource(stageId);

  const points = Array.isArray(pointsRes.data)
    ? pointsRes.data
    : EMPTY_HYSTERESIS_POINTS;
  const branches = Array.isArray(branchesRes.data)
    ? branchesRes.data
    : EMPTY_HYSTERESIS_BRANCHES;
  const minorLoops = Array.isArray(minorLoopsRes.data)
    ? minorLoopsRes.data
    : EMPTY_HYSTERESIS_MINOR_LOOPS;
  const angularFamily = familyRes.data;
  const metrics = metricsRes.data;
  const progress = progressRes.data;
  const branchMode = protocolRes.data?.branch_mode ?? null;

  const [yAxisKey, setYAxisKey] = useState<YAxisKey>("m_parallel");
  const [xAxisUnit, setXAxisUnit] = useState<XAxisUnit>("mT");
  const [viewMode, setViewMode] = useState<ViewMode>("full");
  const [isPlaying, setIsPlaying] = useState(false);

  const elementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const subscribeToSelection = useCallback(
    (onStoreChange: () => void) => kernel.selection.subscribe(onStoreChange),
    [kernel.selection],
  );
  const selectedPointId = useSyncExternalStore(
    subscribeToSelection,
    useCallback(
      () => selectedHysteresisPointId(kernel.selection.get(), stageId),
      [kernel.selection, stageId],
    ),
    useCallback(
      () => selectedHysteresisPointId(kernel.selection.get(), stageId),
      [kernel.selection, stageId],
    ),
  );

  const formatXValue = useCallback((fieldValmT: number) => {
    if (xAxisUnit === "kA/m") return fieldValmT / (4 * Math.PI * 0.1);
    return fieldValmT;
  }, [xAxisUnit]);

  const progressIndex = progressPointIndex(progress);
  const selectedIndex = selectedPointId == null
    ? -1
    : points.findIndex((point) => point.point_id === selectedPointId);
  const selectedResourcePoint = selectedPointId == null
    ? null
    : resolveHysteresisChartPointById(
        points,
        branches,
        minorLoops,
        selectedPointId,
      );
  const navigationIndex = resolveHysteresisNavigationIndex(
    selectedIndex,
    progressIndex,
    points.length,
  );
  const resolvedActiveIndex = navigationIndex;
  const activePoint = selectedResourcePoint ?? points[resolvedActiveIndex] ?? null;
  const liveFieldValue = activePoint?.field_value_mT ?? progress?.current_field_mT ?? null;
  const liveYValue = activePoint ? getPointYValue(activePoint, yAxisKey) : getProgressYValue(progress, yAxisKey);
  const liveSettleLabel = progressSettleLabel(progress);
  const activePointSnapshotId = activePoint?.snapshot_id ?? null;
  const replayAction = hysteresisChartReplayActionPresentation(
    activePointSnapshotId,
    activePoint?.snapshot_storage_status ?? null,
    activePoint?.snapshot_storage_reason ?? null,
  );
  const initialStateAction = hysteresisChartInitialStateActionPresentation(
    activePointSnapshotId,
    activePoint?.snapshot_storage_status ?? null,
    activePoint?.snapshot_storage_reason ?? null,
  );
  const angularFamilyStatus = useMemo(() => {
    const series = Array.isArray(angularFamily?.series) ? angularFamily.series : [];
    if (series.length === 0) return null;
    const computed = series.filter((entry) => entry.point_count > 0).length;
    const pending = series.length - computed;
    return `${computed}/${series.length} angular variants computed${pending > 0 ? `, ${pending} pending` : ""}`;
  }, [angularFamily]);
  const targetMetadata = useMemo(
    () => hysteresisTargetMetadataFromOrientation(orientationRes.data),
    [orientationRes.data],
  );
  const commandContext = useMemo(
    () => createCommandContext(commandSource, kernel),
    [commandSource, kernel],
  );

  const selectPointResource = useCallback((pt: HysteresisPointSchema | null) => {
    if (!pt) return;
    kernel.selection.set(
      buildHysteresisChartPointSelection({
        includeSnapshot: true,
        point: pt,
        stageId,
        targetMetadata,
        yAxisKey,
      }),
        commandSource === "inspector" ? "inspector" : "analysis-plots",
    );
    kernel.commands.execute(
      "hysteresis.load-point-in-3d",
      commandContext,
      buildHysteresisSelectPointCommandInput({
        point: pt,
        stageId,
        targetMetadata,
        yAxisKey,
      }),
    );
  }, [
    commandContext,
    commandSource,
    kernel.commands,
    kernel.selection,
    stageId,
    targetMetadata,
    yAxisKey,
  ]);

  const selectPoint = useCallback((idx: number) => {
    selectPointResource(points[idx] ?? null);
  }, [points, selectPointResource]);

  const returnToLive = useCallback(() => {
    setIsPlaying(false);
    clearHysteresisPointSelectionForLive(kernel, stageId, commandSource);
    kernel.commands.execute("hysteresis.return-to-live", commandContext, {
      stageId,
    });
  }, [commandContext, commandSource, kernel, stageId]);

  const loadSelectedPointIn3D = useCallback(() => {
    if (!activePoint) return;
    kernel.commands.execute(
      "hysteresis.load-point-in-3d",
      commandContext,
      buildHysteresisLoadPointIn3DInput({
        point: activePoint,
        stageId,
        targetMetadata,
        yAxisKey,
      }),
    );
  }, [activePoint, commandContext, kernel.commands, stageId, targetMetadata, yAxisKey]);

  const useSelectedPointAsInitialState = useCallback(() => {
    if (!activePoint) return;
    kernel.commands.execute(
      "hysteresis.use-point-as-initial-state",
      commandContext,
      buildHysteresisUsePointAsInitialStateInput({
        point: activePoint,
        stageId,
      }),
    );
  }, [activePoint, commandContext, kernel.commands, stageId]);

  const resetZoom = useCallback(() => {
    resetHysteresisChartZoom(chartRef.current);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (points.length === 0) return;
      const nextIndex = resolveHysteresisKeyboardNavigationIndex(
        e.key,
        selectedIndex,
        progressIndex,
        points.length,
      );
      if (nextIndex == null) return;
      e.preventDefault();
      selectPoint(nextIndex);
    },
    [selectedIndex, progressIndex, selectPoint, points],
  );

  const advancePlayback = useEffectEvent(() => {
    const next = nextHysteresisPlaybackIndex(
      selectedIndex,
      progressIndex,
      points.length,
    );
    selectPoint(next);
  });

  const handleChartClick = useEffectEvent((params: unknown) => {
    const event = params as ChartClickParams;
    if (event.componentType === "series" && isChartDataPoint(event.data)) {
      const ptId = event.data[2];
      selectPointResource(resolveHysteresisChartPointById(
        points,
        branches,
        minorLoops,
        ptId,
      ));
    }
  });

  useEffect(() => {
    if (!isPlaying || points.length === 0) return;
    const interval = setInterval(() => {
      advancePlayback();
    }, 800);
    return () => clearInterval(interval);
  }, [isPlaying, points.length]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    let chart: ECharts;
    let disposed = false;

    import("echarts").then((echarts) => {
      if (disposed) return;
      chart = echarts.init(element, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      const colors = readHysteresisChartColors(element);

      chart.on("click", handleChartClick);

      const seriesList: Array<Record<string, unknown>> = [];
      const lineSeries = viewMode === "angular-family"
        ? buildHysteresisAngularFamilyLineSeriesModel(
            angularFamily,
            yAxisKey,
            formatXValue,
          )
        : buildHysteresisChartLineSeriesModel(
            points,
            branches,
            minorLoops,
            viewMode,
            yAxisKey,
            formatXValue,
            branchMode,
          );
      const adaptiveMarkerData = buildHysteresisAdaptivePointMarkerModel(
        points,
        branches,
        minorLoops,
        viewMode,
        yAxisKey,
        formatXValue,
        branchMode,
      );
      lineSeries.forEach((series, seriesIndex) => {
        if (series.branchId == null) {
          seriesList.push({
            name: series.name,
            type: "line",
            data: series.data,
            smooth: true,
            showSymbol: true,
            symbolSize: 6,
            lineStyle: { width: 3, color: colors.branchDescending },
            itemStyle: { color: colors.branchDescending },
          });
          return;
        }
        const angularFamilyColors = [
          colors.metric,
          colors.branchAscending,
          colors.branchDescending,
          colors.remanence,
          colors.active,
        ];
        const color = series.branchId.startsWith("angular-family:")
          ? angularFamilyColors[seriesIndex % angularFamilyColors.length]
          : series.branchId.startsWith("oop-overlay")
          ? colors.remanence
          : series.branchId.startsWith("mx-overlay")
            ? colors.metric
            : series.branchId.startsWith("my-overlay")
              ? colors.branchAscending
              : series.branchId.startsWith("mz-overlay")
                ? colors.branchDescending
                : series.branchId.startsWith("ip-overlay") || series.branchId === "ascending"
                  ? colors.branchAscending
                  : colors.branchDescending;
        seriesList.push({
          id: series.branchId,
          name: series.name,
          type: "line",
          data: series.data,
          smooth: true,
          showSymbol: true,
          symbolSize: 6,
          lineStyle: { width: 3, color },
          itemStyle: { color },
        });
      });

      const markPoints: Array<Record<string, unknown>> = [];
      const markLines: Array<Record<string, unknown>> = [];
      const metricMarkers = buildHysteresisMetricMarkerModel({
        formatXValue,
        metrics,
        points,
        yAxisKey,
      });
      metricMarkers.forEach((marker) => {
        markPoints.push({
          name: marker.label,
          value: formatHysteresisMetricMarkerValue(marker),
          coord: [marker.x, marker.value ?? 0],
          itemStyle: { color: hysteresisMetricMarkerColor(marker.kind, colors) },
        });
      });

      if (liveFieldValue != null) {
        markLines.push({
          xAxis: formatXValue(liveFieldValue),
          lineStyle: { type: "dashed", color: colors.textMuted, width: 1 },
          label: { show: false },
        });
      }
      if (activePoint) {
        markLines.push({
          yAxis: getPointYValue(activePoint, yAxisKey),
          lineStyle: { type: "dashed", color: colors.textMuted, width: 1 },
          label: { show: false },
        });
      }
      const tooltipPoints = uniqueHysteresisPointsById([
        ...points,
        ...branches.flatMap((branch) => branch.points),
        ...minorLoops.flatMap((loop) => loop.points),
      ]);

      const option: EChartsOption = {
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis",
          backgroundColor: colors.surface,
          borderColor: colors.border,
          textStyle: { color: colors.text },
          formatter: (params: unknown) =>
            formatHysteresisChartTooltip(params, {
              branchMode,
              points: tooltipPoints,
              xAxisUnit,
            }),
        },
        grid: {
          left: "5%",
          right: "5%",
          bottom: "12%",
          top: "10%",
          containLabel: true,
        },
        xAxis: {
          type: "value",
          scale: HYSTERESIS_CHART_VALUE_AXIS_SCALE,
          name: `Applied Field H [${xAxisUnit}]`,
          nameLocation: "middle",
          nameGap: 30,
          splitLine: { show: true, lineStyle: { color: colors.border } },
          axisLabel: { color: colors.axis },
        },
        yAxis: {
          type: "value",
          scale: HYSTERESIS_CHART_VALUE_AXIS_SCALE,
          name: viewMode === "oop-ip-overlay"
            ? "Magnetization M/Ms (oop / ip)"
            : viewMode === "rgb-overlay"
              ? "Magnetization M/Ms (x / y / z)"
              : viewMode === "angular-family"
                ? `Magnetization M/Ms (${yAxisKey.replace("m_", "")}) by angle`
            : `Magnetization M/Ms (${yAxisKey.replace("m_", "")})`,
          splitLine: { show: true, lineStyle: { color: colors.border } },
          axisLabel: { color: colors.axis },
        },
        dataZoom: buildHysteresisChartDataZoomModel(colors),
        series: [
          ...seriesList.map((s) => ({
            ...s,
            id: typeof s.id === "string"
              ? s.id
              : typeof s.name === "string"
                ? s.name
                : undefined,
            markPoint: markPoints.length > 0 ? {
              symbol: "pin",
              symbolSize: 30,
              label: { show: false },
              data: markPoints,
            } : undefined,
            markLine: markLines.length > 0 ? {
              symbol: ["none", "none"],
              data: markLines,
            } : undefined,
          })),
          ...(adaptiveMarkerData.length > 0 ? [{
            name: "Adaptive refinement points",
            type: "scatter",
            coordinateSystem: "cartesian2d",
            data: adaptiveMarkerData,
            symbol: "diamond",
            symbolSize: 11,
            itemStyle: {
              borderColor: colors.surface,
              borderWidth: 1,
              color: colors.metric,
            },
            z: 9,
          }] : []),
          ...(activePoint ? [{
            name: "Active Point",
            type: "effectScatter",
            coordinateSystem: "cartesian2d",
            data: [[formatXValue(activePoint.field_value_mT), getPointYValue(activePoint, yAxisKey)]],
            symbolSize: 12,
            showEffectOn: "render",
            rippleEffect: { brushType: "stroke", scale: 3 },
            itemStyle: { color: colors.active },
            z: 10,
          }] : liveFieldValue != null && liveYValue != null ? [{
            name: "Live Field",
            type: "effectScatter",
            coordinateSystem: "cartesian2d",
            data: [[formatXValue(liveFieldValue), liveYValue]],
            symbolSize: 10,
            showEffectOn: "render",
            rippleEffect: { brushType: "stroke", scale: 2 },
            itemStyle: { color: colors.active },
            z: 10,
          }] : []),
        ] as EChartsOption["series"],
      };

      chart.setOption(option);
    });

    const resizeObserver = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    resizeObserver.observe(element);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      chartRef.current?.off("click", handleChartClick);
      chartRef.current?.dispose();
    };
  }, [activePoint, angularFamily, branchMode, branches, formatXValue, liveFieldValue, liveYValue, metrics, minorLoops, points, progress, viewMode, xAxisUnit, yAxisKey]);

  return (
    <div
      className="fm-hysteresis-container"
      data-hysteresis-active-point-id={activePoint?.point_id ?? ""}
      data-hysteresis-active-snapshot-id={activePointSnapshotId ?? ""}
      data-hysteresis-live-field-mt={liveFieldValue ?? ""}
      data-hysteresis-point-count={points.length}
      data-hysteresis-stage-id={stageId}
      role="group"
      aria-label="Hysteresis chart"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="fm-hysteresis-controls">
        <div className="fm-hysteresis-control-group">
          <select
            className="fm-analysis-plots__select"
            value={yAxisKey}
            onChange={(e) => setYAxisKey(e.target.value as YAxisKey)}
          >
            <option value="m_parallel">M_parallel</option>
            <option value="m_oop">M_oop</option>
            <option value="m_ip">M_ip</option>
            <option value="m_avg_x">M_x</option>
            <option value="m_avg_y">M_y</option>
            <option value="m_avg_z">M_z</option>
          </select>

          <select
            className="fm-analysis-plots__select"
            value={xAxisUnit}
            onChange={(e) => setXAxisUnit(e.target.value as XAxisUnit)}
          >
            <option value="mT">mT (B_ext)</option>
            <option value="kA/m">kA/m (H_ext)</option>
          </select>

          <select
            className="fm-analysis-plots__select"
            value={viewMode}
            onChange={(e) => {
              if (isViewMode(e.target.value)) {
                setViewMode(e.target.value);
              }
            }}
          >
            <option value="full">Full Loop</option>
            <option value="virgin">Virgin</option>
            <option value="forward">Forward Branch</option>
            <option value="return">Return Branch</option>
            <option value="minor">Minor Loops</option>
            <option value="oop-ip-overlay">OOP/IP Overlay</option>
            <option value="rgb-overlay">RGB Components</option>
            <option value="angular-family">Angular Family</option>
          </select>
        </div>

        {viewMode === "angular-family" && angularFamilyStatus ? (
          <div className="fm-hysteresis-status">
            {angularFamilyStatus}
          </div>
        ) : null}

        <div className="fm-hysteresis-player-controls">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              selectPoint(
                adjacentHysteresisPointIndex(
                  selectedIndex,
                  progressIndex,
                  points.length,
                  -1,
                ),
              )
            }
            disabled={navigationIndex <= 0}
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setIsPlaying(!isPlaying)}
            className="fm-hysteresis-play-button"
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? "Pause" : "Play Loop"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              selectPoint(
                adjacentHysteresisPointIndex(
                  selectedIndex,
                  progressIndex,
                  points.length,
                  1,
                ),
              )
            }
            disabled={points.length === 0 || navigationIndex >= points.length - 1}
          >
            <ChevronRight size={16} />
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={loadSelectedPointIn3D}
            disabled={replayAction.disabled}
            title={replayAction.title}
          >
            Load in 3D
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={useSelectedPointAsInitialState}
            disabled={initialStateAction.disabled}
            title={initialStateAction.title}
          >
            Use as initial
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={resetZoom}
            disabled={points.length === 0}
            title="Reset local chart zoom"
          >
            <ZoomOut size={14} />
            Reset zoom
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={returnToLive}
            title="Return the 3D viewport to the live magnetization field"
          >
            Live
          </Button>
        </div>
      </div>

      <div
        ref={elementRef}
        className="fm-hysteresis-chart-canvas"
      />

      {(points.length > 0 || liveFieldValue != null) && (
        <div className="fm-hysteresis-scrubber-panel">
          <div className="fm-hysteresis-scrubber-readout">
            <span>
              Point {resolvedActiveIndex >= 0 ? resolvedActiveIndex + 1 : 0}
              {progress?.total_points
                ? ` of ${progress.total_points}`
                : points.length > 0
                  ? ` of ${points.length}`
                  : ""}
            </span>
            {activePoint && (
              <span className="fm-hysteresis-scrubber-active">
                H = {activePoint.field_value_mT.toFixed(2)} mT | M = {getPointYValue(activePoint, yAxisKey).toFixed(5)}
              </span>
            )}
            {!activePoint && liveFieldValue != null && (
              <span className="fm-hysteresis-scrubber-active">
                H = {liveFieldValue.toFixed(2)} mT{liveSettleLabel ? ` | ${liveSettleLabel}` : ""}
              </span>
            )}
          </div>
          {points.length > 0 && (
            <input
              type="range"
              min="0"
              max={points.length - 1}
              value={resolvedActiveIndex >= 0 ? resolvedActiveIndex : 0}
              onChange={(e) => {
                const nextIndex = resolveHysteresisScrubberPointIndex(
                  e.target.value,
                  points.length,
                );
                if (nextIndex != null) selectPoint(nextIndex);
              }}
              aria-label="Hysteresis point scrubber"
              className="fm-hysteresis-scrubber"
            />
          )}
        </div>
      )}
    </div>
  );
}
