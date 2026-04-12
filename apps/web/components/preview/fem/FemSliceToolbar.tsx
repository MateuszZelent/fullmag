"use client";

/**
 * Semantic toolbar for the 2D FEM slice viewport.
 *
 * Organized into sections: Mode, Plane, Position, Thickness,
 * Aggregation, Scale — matching the plan's UX spec.
 */

import { useCallback } from "react";
import type { FemSliceViewportModel } from "./useFemSliceViewportModel";
import type {
  ThicknessMode,
  SliceAggregation,
  SlicePlane,
  ColorScaleMode,
} from "./femSliceQuery";
import { sliceTitle } from "./femSliceQuery";
import { formatMetricLength } from "./femSliceProbe";
import { cn } from "@/lib/utils";

// ── Toolbar Props ────────────────────────────────────────────────

export interface FemSliceToolbarProps {
  model: FemSliceViewportModel;
  /** Whether the toolbar should show compact layout (narrow viewports). */
  compact?: boolean;
  className?: string;
}

// ── Component ────────────────────────────────────────────────────

export function FemSliceToolbar({ model, compact = false, className }: FemSliceToolbarProps) {
  const { query, resolved, isSyncedTo3D } = model;

  // ── Plane position as slider value (always 0–100 for the slider) ──
  const sliderValue =
    query.positionMode === "sync_3d_clip"
      ? query.planeOffset
      : query.positionMode === "normalized"
        ? query.planeOffset * 100
        : resolved.normalExtent.span > 0
          ? ((query.planeOffset - resolved.normalExtent.min) / resolved.normalExtent.span) * 100
          : 50;

  const handleSlider = useCallback(
    (value: number) => {
      if (query.positionMode === "sync_3d_clip") {
        model.syncFromClip(value);
      } else if (query.positionMode === "normalized") {
        model.setPlaneOffset(value / 100);
      } else {
        const world = resolved.normalExtent.min + (value / 100) * resolved.normalExtent.span;
        model.setPlaneOffset(world);
      }
    },
    [query.positionMode, model, resolved.normalExtent],
  );

  const stepPlane = useCallback(
    (direction: 1 | -1) => {
      const step = resolved.normalExtent.span * 0.02; // 2% step
      const next = resolved.planeWorldCoord + direction * step;
      model.jumpToWorld(
        Math.max(resolved.normalExtent.min, Math.min(resolved.normalExtent.max, next)),
      );
    },
    [model, resolved],
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-card/60",
        "backdrop-blur-md px-3 py-1.5 shadow-sm pointer-events-auto",
        compact ? "gap-1.5 px-2 py-1" : "",
        className,
      )}
    >
      {/* ── Section: Mode ───────────────────────────── */}
      <ToolbarSection label="Mode" compact={compact}>
        <SegmentedButtons<ThicknessMode>
          options={[
            { value: "exact", label: "Section" },
            { value: "slab", label: "Slab" },
            { value: "projection", label: "Projection" },
          ]}
          value={query.thicknessMode}
          onChange={model.setThicknessMode}
        />
      </ToolbarSection>

      {/* ── Section: Plane ──────────────────────────── */}
      <ToolbarSection label="Plane" compact={compact}>
        <SegmentedButtons<SlicePlane>
          options={[
            { value: "xy", label: "XY" },
            { value: "xz", label: "XZ" },
            { value: "yz", label: "YZ" },
          ]}
          value={query.orientation}
          onChange={model.setOrientation}
        />
      </ToolbarSection>

      {/* ── Section: Position ───────────────────────── */}
      <ToolbarSection label="Position" compact={compact}>
        <span className="text-[0.65rem] font-mono text-muted-foreground tabular-nums min-w-[72px] text-right">
          {resolved.normalLabel} = {formatMetricLength(resolved.planeWorldCoord)}
        </span>
        <button
          className="rounded px-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          onClick={() => stepPlane(-1)}
          title="Step backward"
        >
          −
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={sliderValue}
          onChange={(e) => handleSlider(Number(e.target.value))}
          className={cn("accent-primary", compact ? "w-24" : "w-32")}
        />
        <button
          className="rounded px-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          onClick={() => stepPlane(1)}
          title="Step forward"
        >
          +
        </button>
        {/* Sync toggle */}
        <button
          className={cn(
            "rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider transition-colors",
            isSyncedTo3D
              ? "bg-primary/20 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
          onClick={() => {
            if (isSyncedTo3D) {
              model.jumpToWorld(resolved.planeWorldCoord);
            } else {
              model.syncFromClip(sliderValue);
            }
          }}
          title={isSyncedTo3D ? "Desync from 3D clip" : "Sync with 3D clip"}
        >
          {isSyncedTo3D ? "Sync ON" : "Sync"}
        </button>
      </ToolbarSection>

      {/* ── Section: Thickness (only for slab / projection) ── */}
      {query.thicknessMode !== "exact" && (
        <ToolbarSection label="Thickness" compact={compact}>
          <span className="text-[0.65rem] font-mono text-muted-foreground tabular-nums">
            {formatMetricLength(query.thicknessWorld * 2)}
          </span>
          <input
            type="range"
            min={0}
            max={resolved.normalExtent.span}
            step={resolved.normalExtent.span * 0.01}
            value={query.thicknessWorld}
            onChange={(e) => model.setThickness(Number(e.target.value))}
            className="w-20 accent-primary"
          />
        </ToolbarSection>
      )}

      {/* ── Section: Aggregation ────────────────────── */}
      {query.thicknessMode !== "exact" && (
        <ToolbarSection label="Aggregation" compact={compact}>
          <SegmentedButtons<SliceAggregation>
            options={[
              { value: "mean", label: "Mean" },
              { value: "min", label: "Min" },
              { value: "max", label: "Max" },
              { value: "integral", label: "∫" },
              { value: "rms", label: "RMS" },
            ]}
            value={query.aggregation}
            onChange={model.setAggregation}
          />
        </ToolbarSection>
      )}

      {/* ── Section: Scale ──────────────────────────── */}
      <ToolbarSection label="Scale" compact={compact}>
        <SegmentedButtons<ColorScaleMode>
          options={[
            { value: "slice_auto", label: "Auto" },
            { value: "global_auto", label: "Global" },
            { value: "symmetric_zero", label: "Sym 0" },
            { value: "locked_manual", label: "Lock" },
          ]}
          value={query.colorScaleMode}
          onChange={model.setColorScaleMode}
        />
      </ToolbarSection>
    </div>
  );
}

// ── Self-describing title bar ────────────────────────────────────

export interface FemSliceTitleBarProps {
  model: FemSliceViewportModel;
  className?: string;
}

export function FemSliceTitleBar({ model, className }: FemSliceTitleBarProps) {
  const title = sliceTitle(model.query, model.resolved.planeWorldCoord);
  return (
    <div
      className={cn(
        "rounded-lg border border-border/30 bg-background/78 px-3 py-1 text-[0.68rem]",
        "font-mono text-slate-200 shadow-lg backdrop-blur-md pointer-events-auto",
        className,
      )}
    >
      {title}
    </div>
  );
}

// ── Internal components ──────────────────────────────────────────

function ToolbarSection({
  label,
  compact,
  children,
}: {
  label: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          "font-semibold uppercase tracking-wider text-muted-foreground select-none",
          compact ? "text-[0.55rem]" : "text-[0.6rem]",
        )}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function SegmentedButtons<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border/50 bg-background/50 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={cn(
            "px-2 py-0.5 text-[0.65rem] font-mono transition-colors",
            opt.value === value
              ? "bg-primary/20 text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
