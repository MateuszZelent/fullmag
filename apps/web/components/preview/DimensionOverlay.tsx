"use client";

import { useMemo } from "react";
import { pickUnitScale } from "../../lib/units";

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
function pickUnit(extent: number) {
  return pickUnitScale(extent);
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

  return (
    <div className="absolute inset-0 pointer-events-none z-[8] overflow-hidden">
      {/* ── Bottom axis (X) ── */}
      <div className="absolute bottom-[28px] left-[64px] right-[48px] flex items-end gap-1.5">
        <div className="flex-1 h-size-dimension-marker relative border-b border-border/40">
          <svg className="w-full h-full overflow-visible" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
            {xTicks.map((v) => {
              const x = axes.x.extent > 0 ? (v / axes.x.extent) * 100 : 0;
              return (
                <g key={v}>
                  <line x1={x} x2={x} y1="0" y2="6" className="stroke-muted-foreground/50 stroke-1" />
                  <text x={x} y="16" textAnchor="middle" className="text-[0.55rem] font-semibold font-mono fill-muted-foreground/70 whitespace-nowrap [dominant-baseline:hanging]">
                    {fmtTickLabel(v)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <span className="text-[0.6rem] font-bold text-muted-foreground/60 font-mono whitespace-nowrap mb-[1px]">{axes.unit}</span>
      </div>

      {/* ── Left axis (Y) ── */}
      <div className="absolute left-[28px] top-[16px] bottom-[64px] flex flex-col items-end gap-1.5">
        <div className="flex-1 w-size-dimension-marker relative border-l border-border/40">
          <svg className="w-full h-full overflow-visible" viewBox="0 0 24 100" preserveAspectRatio="none" aria-hidden="true">
            {yTicks.map((v) => {
              const y = axes.y.extent > 0 ? 100 - (v / axes.y.extent) * 100 : 100;
              return (
                <g key={v}>
                  <line x1="0" x2="6" y1={y} y2={y} className="stroke-muted-foreground/50 stroke-1" />
                  <text x="18" y={y + 2} textAnchor="end" className="text-[0.55rem] font-semibold font-mono fill-muted-foreground/70 whitespace-nowrap [dominant-baseline:middle]">
                    {fmtTickLabel(v)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <span className="text-[0.6rem] font-bold text-muted-foreground/60 font-mono whitespace-nowrap [writing-mode:vertical-lr] rotate-180 mb-[3px]">{axes.unit}</span>
      </div>



      {/* ── Grid info badge (top-right) ── */}
      {gridCells && (
        <div className="absolute top-2 right-2 text-[0.58rem] font-bold font-mono text-muted-foreground/60 bg-card/70 py-0.5 px-1.5 rounded border border-border/30">
          {gridCells[0]}×{gridCells[1]}×{gridCells[2]}
        </div>
      )}

      {/* ── Dimension summary badge ── */}
      <div className="absolute top-2 left-2 text-[0.58rem] font-bold font-mono text-muted-foreground/60 bg-card/70 py-0.5 px-1.5 rounded border border-border/30">
        {fmtTickLabel(axes.x.extent)} × {fmtTickLabel(axes.y.extent)} × {fmtTickLabel(axes.z.extent)} {axes.unit}
      </div>
    </div>
  );
}
