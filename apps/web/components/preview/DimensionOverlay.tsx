"use client";

import { useMemo } from "react";
import s from "./DimensionOverlay.module.css";

/* ── Types ── */

interface DimensionOverlayProps {
  /** Physical extent per axis [x, y, z] in metres */
  worldExtent: [number, number, number] | null;
  /** Grid cells per axis [nx, ny, nz] */
  gridCells?: [number, number, number] | null;
  /** Whether the geometry is visible (show only when viewport has content) */
  visible?: boolean;
}

/* ── Helpers ── */

/** Pick SI prefix for a length in metres */
function pickUnit(extent: number): { scale: number; unit: string } {
  const abs = Math.abs(extent);
  if (abs >= 1e-2) return { scale: 1e3, unit: "mm" };
  if (abs >= 1e-5) return { scale: 1e6, unit: "µm" };
  return { scale: 1e9, unit: "nm" };
}

/** Generate nice tick values for an axis from 0 to `maxVal` (already scaled) */
function niceTickValues(maxVal: number, maxTicks = 5): number[] {
  if (maxVal <= 0) return [0];
  const raw = maxVal / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step: number;
  if (norm <= 1.5) step = 1 * mag;
  else if (norm <= 3) step = 2 * mag;
  else if (norm <= 7) step = 5 * mag;
  else step = 10 * mag;

  const ticks: number[] = [];
  for (let v = 0; v <= maxVal + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6); // avoid float noise
    if (ticks.length >= maxTicks + 1) break;
  }
  return ticks;
}

function fmtTickLabel(v: number): string {
  if (v === 0) return "0";
  if (Number.isInteger(v)) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toPrecision(3);
}

/* ── Component ── */

export default function DimensionOverlay({
  worldExtent,
  gridCells,
  visible = true,
}: DimensionOverlayProps) {
  const axes = useMemo(() => {
    if (!worldExtent) return null;
    const [wx, wy, wz] = worldExtent;
    const maxExtent = Math.max(wx, wy, wz);
    if (maxExtent <= 0) return null;
    const { scale, unit } = pickUnit(maxExtent);

    return {
      x: { label: "x", extent: wx * scale, unit },
      y: { label: "y", extent: wy * scale, unit },
      z: { label: "z", extent: wz * scale, unit },
      unit,
    };
  }, [worldExtent]);

  if (!visible || !axes) return null;

  const xTicks = niceTickValues(axes.x.extent);
  const yTicks = niceTickValues(axes.y.extent);
  const zTicks = niceTickValues(axes.z.extent);

  return (
    <div className={s.overlay}>
      {/* ── Bottom axis (X) ── */}
      <div className={s.axisBottom}>
        <div className={s.axisLine}>
          {xTicks.map((v) => (
            <span
              key={v}
              className={s.tick}
              style={{ left: `${axes.x.extent > 0 ? (v / axes.x.extent) * 100 : 0}%` }}
            >
              <span className={s.tickMark} />
              <span className={s.tickLabel}>{fmtTickLabel(v)}</span>
            </span>
          ))}
        </div>
        <span className={s.axisLabel}>{axes.unit}</span>
      </div>

      {/* ── Left axis (Y) ── */}
      <div className={s.axisLeft}>
        <div className={s.axisLine}>
          {yTicks.map((v) => (
            <span
              key={v}
              className={s.tick}
              style={{ bottom: `${axes.y.extent > 0 ? (v / axes.y.extent) * 100 : 0}%` }}
            >
              <span className={s.tickMark} />
              <span className={s.tickLabel}>{fmtTickLabel(v)}</span>
            </span>
          ))}
        </div>
        <span className={s.axisLabel}>{axes.unit}</span>
      </div>

      {/* ── Axis gizmo (bottom-left corner) ── */}
      <div className={s.axisGizmo}>
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          {/* Z axis (up) */}
          <line x1="12" y1="40" x2="12" y2="12" stroke="var(--axis-z, #4488ff)" strokeWidth="1.5" />
          <polygon points="12,8 9,14 15,14" fill="var(--axis-z, #4488ff)" />
          <text x="4" y="8" fontSize="8" fill="var(--axis-z, #4488ff)" fontWeight="700">z</text>

          {/* X axis (right) */}
          <line x1="12" y1="40" x2="40" y2="40" stroke="var(--axis-x, #ff4444)" strokeWidth="1.5" />
          <polygon points="44,40 38,37 38,43" fill="var(--axis-x, #ff4444)" />
          <text x="42" y="36" fontSize="8" fill="var(--axis-x, #ff4444)" fontWeight="700">x</text>

          {/* Y axis (diagonal) */}
          <line x1="12" y1="40" x2="32" y2="26" stroke="var(--axis-y, #44cc44)" strokeWidth="1.5" />
          <polygon points="34,24 27,26 30,30" fill="var(--axis-y, #44cc44)" />
          <text x="34" y="22" fontSize="8" fill="var(--axis-y, #44cc44)" fontWeight="700">y</text>
        </svg>
      </div>

      {/* ── Grid info badge (top-right) ── */}
      {gridCells && (
        <div className={s.gridBadge}>
          {gridCells[0]}×{gridCells[1]}×{gridCells[2]}
        </div>
      )}

      {/* ── Dimension summary badge ── */}
      <div className={s.dimBadge}>
        {fmtTickLabel(axes.x.extent)} × {fmtTickLabel(axes.y.extent)} × {fmtTickLabel(axes.z.extent)} {axes.unit}
      </div>
    </div>
  );
}
