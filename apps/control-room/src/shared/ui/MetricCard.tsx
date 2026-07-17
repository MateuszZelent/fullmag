import type { ReactNode } from "react";

import { cn } from "@/shared/utils/className";

interface MetricCardProps {
  /** Primary label for the metric */
  label: string;
  /** Metric value display */
  value: ReactNode;
  /** Optional unit suffix */
  unit?: string;
  /** Optional status hint for coloring */
  status?: "normal" | "warning" | "error" | "success";
  /** Additional CSS class */
  className?: string;
}

/**
 * Shared metric card for displaying numeric KPIs.
 * Used in footer-telemetry, inspector sampling plan, and diagnostics.
 */
export function MetricCard({
  label,
  value,
  unit,
  status,
  className,
}: MetricCardProps) {
  return (
    <div className={cn("fm-metric-card", className)} data-status={status}>
      <span className="fm-metric-card__label">{label}</span>
      <span className="fm-metric-card__value">
        {value}
        {unit && <span className="fm-metric-card__unit">{unit}</span>}
      </span>
    </div>
  );
}
