import type { CrossSectionQualityMetric } from "@/kernel/api/apiTypes";

import type { Viewport2DPolygonSummary } from "./viewport2dRenderModel";

export interface Viewport2DHoverPointer {
  viewportHeight: number;
  viewportWidth: number;
  viewportX: number;
  viewportY: number;
}

export interface Viewport2DPolygonHover {
  pointer: Viewport2DHoverPointer;
  polygon: Viewport2DPolygonSummary;
}

export interface Viewport2DTooltipRow {
  label: string;
  value: string;
}

export interface Viewport2DTooltipContent {
  rows: Viewport2DTooltipRow[];
  title: string;
}

export interface Viewport2DTooltipPosition {
  left: number;
  top: number;
}

const TOOLTIP_WIDTH = 220;
const TOOLTIP_HEIGHT = 128;
const TOOLTIP_OFFSET = 12;
const TOOLTIP_MARGIN = 8;

export function formatViewport2DTooltipContent(
  hover: Viewport2DPolygonHover,
  metric: CrossSectionQualityMetric,
): Viewport2DTooltipContent {
  const polygon = hover.polygon;
  return {
    title: `Parent tet ${polygon.parentElementId}`,
    rows: [
      { label: metric, value: formatNumber(polygon.qualityValue) },
      { label: "polygon", value: polygon.polygonIndex.toString() },
      { label: "triangles", value: polygon.triangleCount.toString() },
      {
        label: "centroid",
        value: `${formatNumber(polygon.centroid.u)}, ${formatNumber(polygon.centroid.v)}`,
      },
    ],
  };
}

export function resolveViewport2DTooltipPosition(
  pointer: Viewport2DHoverPointer,
): Viewport2DTooltipPosition {
  const preferredLeft = pointer.viewportX + TOOLTIP_OFFSET;
  const preferredTop = pointer.viewportY + TOOLTIP_OFFSET;
  const left =
    preferredLeft + TOOLTIP_WIDTH <= pointer.viewportWidth - TOOLTIP_MARGIN
      ? preferredLeft
      : pointer.viewportX - TOOLTIP_WIDTH - TOOLTIP_OFFSET;
  const top =
    preferredTop + TOOLTIP_HEIGHT <= pointer.viewportHeight - TOOLTIP_MARGIN
      ? preferredTop
      : pointer.viewportY - TOOLTIP_HEIGHT - TOOLTIP_OFFSET;

  return {
    left: clamp(left, TOOLTIP_MARGIN, pointer.viewportWidth - TOOLTIP_MARGIN),
    top: clamp(top, TOOLTIP_MARGIN, pointer.viewportHeight - TOOLTIP_MARGIN),
  };
}

function formatNumber(value: number | null): string {
  if (value === null) return "n/a";
  return Number(value.toPrecision(5)).toString();
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(max, Math.max(min, value));
}
