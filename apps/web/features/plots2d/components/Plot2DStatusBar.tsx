"use client";

/**
 * @module features/plots2d/components/Plot2DStatusBar
 *
 * Bottom status strip showing data source badge, sample count,
 * total rows, and plane indicator.
 */

import type { Plot2DScalarState, SlicePlane } from "../model/plot2dTypes";

interface Plot2DStatusBarProps {
  source: Plot2DScalarState["source"];
  rowCount: number;
  totalRows: number;
  loading: boolean;
  plane?: SlicePlane;
}

const SOURCE_LABELS: Record<Plot2DScalarState["source"], string> = {
  empty: "No data",
  "live-window": "Live",
  "full-history": "History",
  "decimated-history": "Decimated",
};

const SOURCE_COLORS: Record<Plot2DScalarState["source"], string> = {
  empty: "text-muted-foreground/40",
  "live-window": "text-emerald-400",
  "full-history": "text-blue-400",
  "decimated-history": "text-amber-400",
};

export function Plot2DStatusBar({
  source,
  rowCount,
  totalRows,
  loading,
  plane,
}: Plot2DStatusBarProps) {
  return (
    <div className="flex items-center gap-3 border-t border-border/10 bg-card/20 px-3 py-1 text-[10px]">
      {/* Source badge */}
      <span className={`font-medium ${SOURCE_COLORS[source]}`}>
        {SOURCE_LABELS[source]}
        {loading && source !== "empty" && (
          <span className="ml-1 animate-pulse">⟳</span>
        )}
      </span>

      <div className="h-3 w-px bg-border/15" />

      {/* Sample count */}
      <span className="text-muted-foreground/60">
        {rowCount.toLocaleString()} samples
        {totalRows > rowCount && (
          <span className="ml-1 text-muted-foreground/40">
            / {totalRows.toLocaleString()} total
          </span>
        )}
      </span>

      <div className="flex-1" />

      {/* Plane indicator (spatial mode) */}
      {plane && (
        <span className="rounded bg-muted/20 px-1.5 py-0.5 font-mono text-muted-foreground/50">
          {plane.toUpperCase()}
        </span>
      )}
    </div>
  );
}

export default Plot2DStatusBar;
