"use client";

import { useMemo } from "react";
import { historyQuantities } from "../../lib/quantities/catalog";
import { fmtExp, fmtSI } from "../../lib/format";

// ── Types ────────────────────────────────────────────────────────

interface ScalarSnapshot {
  step: number;
  time: number;
  [key: string]: number | undefined;
}

interface GlobalScalarPanelProps {
  /** Latest snapshot of scalar values keyed by scalarMetricKey. */
  current: ScalarSnapshot | null;
  /** Additional class for the wrapper. */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────

/**
 * Live panel showing all global scalar quantities from the catalog.
 *
 * Driven entirely by `historyQuantities()` — no hardcoded column
 * lists.  If a new energy term (e.g. E_ani) is added to the catalog,
 * it appears here automatically.
 */
export default function GlobalScalarPanel({
  current,
  className,
}: GlobalScalarPanelProps) {
  const quantities = useMemo(() => historyQuantities(), []);

  if (!current) {
    return (
      <div className={className}>
        <p className="text-sm text-muted-foreground">No data yet.</p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {quantities.map((q) => {
          const key = q.scalarMetricKey;
          const val = key ? current[key] : undefined;
          return (
            <div key={q.id} className="flex justify-between">
              <span className="text-muted-foreground truncate">
                {q.label}
              </span>
              <span className="font-mono tabular-nums">
                {val != null && Number.isFinite(val)
                  ? formatScalar(val, q.unit)
                  : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatScalar(v: number, unit: string): string {
  if (unit === "J" || unit === "A/m") return fmtExp(v);
  if (unit === "s") return fmtSI(v, "s");
  return v.toFixed(6);
}
