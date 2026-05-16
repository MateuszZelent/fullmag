"use client";

/**
 * @module features/plots2d/components/SeriesInspector
 *
 * Sidebar panel showing live statistics for each active series.
 */

import { useMemo } from "react";
import type { ScalarTable } from "../model/plot2dTypes";
import { computeColumnStats } from "../model/scalarTable";

// ─────────────────────────────────────────────────────────────────

const SERIES_PALETTE = [
  "#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa",
  "#fb923c", "#38bdf8", "#e879f9", "#4ade80", "#f87171",
  "#22d3ee", "#facc15",
] as const;

function formatSI(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e3 || abs < 1e-2) return value.toExponential(3);
  return value.toPrecision(5);
}

interface SeriesInspectorProps {
  table: ScalarTable;
  seriesKeys: string[];
}

export function SeriesInspector({ table, seriesKeys }: SeriesInspectorProps) {
  const stats = useMemo(() => {
    return seriesKeys.map((key) => ({
      key,
      meta: table.metaByKey[key] ?? null,
      stats: computeColumnStats(table, key),
    }));
  }, [table, seriesKeys]);

  return (
    <div className="p-2">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        Series
      </div>
      <div className="flex flex-col gap-2">
        {stats.map((entry, idx) => {
          const color = SERIES_PALETTE[idx % SERIES_PALETTE.length];
          const label = entry.meta?.label ?? entry.key;
          const unit = entry.meta?.unit ?? "";
          const s = entry.stats;

          return (
            <div
              key={entry.key}
              className="rounded-md border border-border/10 bg-card/30 p-2"
            >
              <div className="mb-1.5 flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-[11px] font-medium text-foreground/80 truncate">
                  {label}
                </span>
              </div>
              {s ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                  <StatRow label="Last" value={formatSI(s.last)} unit={unit} />
                  <StatRow label="Min" value={formatSI(s.min)} unit={unit} />
                  <StatRow label="Max" value={formatSI(s.max)} unit={unit} />
                  <StatRow label="Mean" value={formatSI(s.mean)} unit={unit} />
                  <StatRow
                    label="Δ"
                    value={formatSI(s.max - s.min)}
                    unit={unit}
                  />
                  <StatRow label="N" value={String(s.count)} />
                </div>
              ) : (
                <div className="text-[10px] text-muted-foreground/50">
                  No data
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <>
      <span className="text-muted-foreground/60">{label}</span>
      <span className="text-right font-mono text-foreground/70">
        {value}
        {unit && <span className="ml-0.5 text-muted-foreground/40">{unit}</span>}
      </span>
    </>
  );
}

export default SeriesInspector;
