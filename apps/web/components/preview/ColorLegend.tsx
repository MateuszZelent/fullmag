"use client";

import { useMemo } from "react";
import { useControlRoom } from "../runs/control-room/ControlRoomContext";
import { fmtExp } from "../runs/control-room/shared";
import css from "./ColorLegend.module.css";

type LegendGradient = "orientation" | "diverging" | "magnitude";

function selectGradient(colorField: string): LegendGradient {
  if (colorField === "orientation") return "orientation";
  if (colorField === "x" || colorField === "y" || colorField === "z") return "diverging";
  return "magnitude";
}

function componentLabel(colorField: string, quantity: string): string {
  if (colorField === "orientation") return "HSL";
  if (colorField === "x") return `${quantity}_x`;
  if (colorField === "y") return `${quantity}_y`;
  if (colorField === "z") return `${quantity}_z`;
  return "|m|";
}

function formatValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs < 1e-2 || abs >= 1e4) return fmtExp(v);
  return v.toPrecision(3);
}

/**
 * ColorLegend — persistent vertical strip for the viewport.
 * Reads state via useControlRoom() to display the active colormap,
 * numerical range, and component indicator.
 */
export default function ColorLegend() {
  const ctx = useControlRoom();

  const colorField = ctx.femColorField ?? "magnitude";
  const quantity = ctx.requestedPreviewQuantity ?? "m";

  const gradient = selectGradient(colorField);
  const label = componentLabel(colorField, quantity);

  /* Numeric range from field stats if available */
  const maxVal = useMemo(() => {
    if (!ctx.fieldStats) return null;
    if (colorField === "x") return Math.max(Math.abs(ctx.fieldStats.minX), Math.abs(ctx.fieldStats.maxX));
    if (colorField === "y") return Math.max(Math.abs(ctx.fieldStats.minY), Math.abs(ctx.fieldStats.maxY));
    if (colorField === "z") return Math.max(Math.abs(ctx.fieldStats.minZ), Math.abs(ctx.fieldStats.maxZ));
    /* magnitude — approximate from vector maxes */
    const mx = Math.max(Math.abs(ctx.fieldStats.maxX), Math.abs(ctx.fieldStats.minX));
    const my = Math.max(Math.abs(ctx.fieldStats.maxY), Math.abs(ctx.fieldStats.minY));
    const mz = Math.max(Math.abs(ctx.fieldStats.maxZ), Math.abs(ctx.fieldStats.minZ));
    return Math.sqrt(mx * mx + my * my + mz * mz);
  }, [ctx.fieldStats, colorField]);

  const minVal = useMemo(() => {
    if (!ctx.fieldStats) return null;
    if (colorField === "x") return ctx.fieldStats.minX;
    if (colorField === "y") return ctx.fieldStats.minY;
    if (colorField === "z") return ctx.fieldStats.minZ;
    return 0; /* magnitude always starts at 0 */
  }, [ctx.fieldStats, colorField]);

  /* Don't render when there's no data at all */
  if (!ctx.hasSolverTelemetry && !ctx.femMeshData) return null;

  return (
    <div className={css.root}>
      <span className={css.label}>{formatValue(maxVal)}</span>
      <div className={css.track} data-gradient={gradient} />
      <span className={css.label}>{formatValue(minVal)}</span>
      <span className={css.indicator}>{label}</span>
    </div>
  );
}
