"use client";

import { useMemo } from "react";

import type {
  CrossSectionQualityMetric,
  SliceMeshColorScale,
} from "@/kernel/api/apiTypes";

import { resolveViewport2DQualityColor } from "./viewport2dRenderModel";

interface Viewport2DColorbarProps {
  colorScale: SliceMeshColorScale;
  metric: CrossSectionQualityMetric;
  range: { max: number; min: number } | null;
}

export function Viewport2DColorbar({
  colorScale,
  metric,
  range,
}: Viewport2DColorbarProps) {
  const gradientStyle = useMemo(() => {
    if (!range) return undefined;
    return { background: colorbarGradient(colorScale, range) };
  }, [colorScale, range]);

  if (!range) return null;

  return (
    <div
      aria-label={`${metric} color scale from ${formatTick(range.min)} to ${formatTick(range.max)}`}
      className="fm-viewport-2d__colorbar"
      role="img"
    >
      <div className="fm-viewport-2d__colorbar-header">
        <span>{metric}</span>
        <span>{colorScale}</span>
      </div>
      <div
        className="fm-viewport-2d__colorbar-gradient"
        style={gradientStyle}
      />
      <div className="fm-viewport-2d__colorbar-ticks">
        <span>{formatTick(range.min)}</span>
        <span>{formatTick((range.min + range.max) * 0.5)}</span>
        <span>{formatTick(range.max)}</span>
      </div>
    </div>
  );
}

export function colorbarGradient(
  colorScale: SliceMeshColorScale,
  range: { max: number; min: number },
): string {
  const stops = Array.from({ length: 9 }, (_, index) => {
    const t = index / 8;
    const value = range.min + (range.max - range.min) * t;
    const [r, g, b] = resolveViewport2DQualityColor(value, range, colorScale);
    return `rgb(${toRgbByte(r)} ${toRgbByte(g)} ${toRgbByte(b)}) ${Math.round(t * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function toRgbByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function formatTick(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3) {
    return value.toExponential(2);
  }
  return Number(value.toPrecision(4)).toString();
}
