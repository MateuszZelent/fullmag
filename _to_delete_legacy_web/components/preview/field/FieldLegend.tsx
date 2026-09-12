"use client";

interface FieldLegendProps {
  /** What color represents */
  colorLabel: string;
  /** What arrow length represents (or null if N/A) */
  lengthLabel?: string;
  /** Unit string for the field, e.g. "A/m" */
  unit?: string;
  /** Min value in the dataset */
  min?: number;
  /** Max value in the dataset */
  max?: number;
  /** Mean value */
  mean?: number;
  /** Colormap gradient CSS string, e.g. "linear-gradient(to right, blue, white, red)" */
  gradient?: string;
  className?: string;
  compact?: boolean;
}

function formatSI(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + " G";
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + " M";
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + " k";
  if (abs >= 1) return v.toFixed(3);
  if (abs >= 1e-3) return (v * 1e3).toFixed(2) + " m";
  if (abs >= 1e-6) return (v * 1e6).toFixed(2) + " μ";
  if (abs >= 1e-9) return (v * 1e9).toFixed(2) + " n";
  return v.toExponential(2);
}

/**
 * Shared field visualization legend — shows color bar, labels, and stats.
 * Usable in both 2D and 3D viewports.
 */
export function FieldLegend({
  colorLabel,
  lengthLabel,
  unit,
  min,
  max,
  mean,
  gradient = "linear-gradient(to right, #3b82f6, #ffffff, #ef4444)",
  className,
  compact = false,
}: FieldLegendProps) {
  return (
    <div
      className={[
        "rounded-lg bg-slate-800/90 border border-slate-500/20 backdrop-blur-sm",
        compact ? "p-1.5 space-y-1 max-w-[180px]" : "p-2 space-y-1.5 max-w-[220px]",
        className ?? "absolute bottom-3 left-3 z-10",
      ].join(" ")}
    >
      {/* Color bar */}
      <div className="space-y-0.5">
        <div
          className="h-3 w-full rounded-sm"
          style={{ background: gradient }}
        />
        {min !== undefined && max !== undefined && (
          <div className="flex justify-between text-[9px] text-slate-400 tabular-nums">
            <span>{formatSI(min)}</span>
            <span>{formatSI(max)}</span>
          </div>
        )}
      </div>

      {/* Labels */}
      <div className={compact ? "text-[9px] text-slate-300 space-y-0.5" : "text-[10px] text-slate-300 space-y-0.5"}>
        <div>
          <span className="text-slate-400">Color: </span>
          {colorLabel}
          {unit && <span className="text-slate-500"> [{unit}]</span>}
        </div>
        {lengthLabel && (
          <div>
            <span className="text-slate-400">Length: </span>
            {lengthLabel}
          </div>
        )}
      </div>

      {/* Stats */}
      {mean !== undefined && (
        <div className="text-[9px] text-slate-500">
          mean: {formatSI(mean)}{unit ? ` ${unit}` : ""}
        </div>
      )}
    </div>
  );
}
