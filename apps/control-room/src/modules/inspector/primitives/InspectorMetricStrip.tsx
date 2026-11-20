import type { ReactNode } from "react";

import { cn } from "@/shared/utils/className";

export type InspectorMetricTone =
  | "accent"
  | "danger"
  | "degraded"
  | "neutral"
  | "stale"
  | "success"
  | "warning";

export interface InspectorMetric {
  label: string;
  tone?: InspectorMetricTone;
  value: ReactNode;
}

export interface InspectorMetricStripProps {
  className?: string;
  /** Key facts for the selected node; the strip shows at most four. */
  metrics: readonly InspectorMetric[];
}

const toneClasses: Record<InspectorMetricTone, string> = {
  accent: "text-fm-accent",
  danger: "text-fm-danger",
  degraded: "text-fm-degraded",
  neutral: "text-fm-primary",
  stale: "text-fm-stale",
  success: "text-fm-success",
  warning: "text-fm-warning",
};

const MAX_METRICS = 4;
const UNKNOWN_VALUES = new Set(["", "unknown", "n/a", "-", "—"]);

/**
 * A fact the Inspector cannot state is omitted instead of shown as
 * "unknown" (specs/frontend-v2/13 §1a, slot 3).
 */
export function isKnownMetricValue(value: ReactNode): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") {
    return !UNKNOWN_VALUES.has(value.trim().toLowerCase());
  }
  return true;
}

const columnClasses: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 @[26rem]:grid-cols-4",
};

export function InspectorMetricStrip({
  className,
  metrics,
}: InspectorMetricStripProps) {
  const visible = metrics
    .filter((metric) => isKnownMetricValue(metric.value))
    .slice(0, MAX_METRICS);
  if (visible.length === 0) return null;

  return (
    <ul
      className={cn(
        "fm-inspector-metric-strip m-0 grid min-w-0 list-none p-0",
        columnClasses[visible.length],
        className,
      )}
      data-count={visible.length}
      data-slot="inspector-metric-strip"
    >
      {visible.map((metric) => {
        const tone = metric.tone ?? "neutral";
        return (
          <li
            className="fm-inspector-metric-card"
            data-slot="inspector-metric"
            key={metric.label}
          >
            <span className="fm-inspector-metric-card__label">
              {metric.label}
            </span>
            <span
              className={cn(
                "fm-inspector-metric-card__value",
                toneClasses[tone],
              )}
              data-state={tone}
              title={typeof metric.value === "string" ? metric.value : undefined}
            >
              {metric.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
