import type { ReactNode } from "react";

import { cn } from "@/shared/utils/className";

export type InspectorMetricTone =
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

type InspectorMetricSet =
  | readonly [InspectorMetric, InspectorMetric]
  | readonly [
      InspectorMetric,
      InspectorMetric,
      InspectorMetric,
      InspectorMetric,
    ];

export interface InspectorMetricStripProps {
  className?: string;
  metrics: InspectorMetricSet;
}

const toneClasses: Record<InspectorMetricTone, string> = {
  danger: "text-fm-danger",
  degraded: "text-fm-degraded",
  neutral: "text-fm-primary",
  stale: "text-fm-stale",
  success: "text-fm-success",
  warning: "text-fm-warning",
};

export function InspectorMetricStrip({
  className,
  metrics,
}: InspectorMetricStripProps) {
  return (
    <ul
      className={cn(
        "fm-inspector-metric-strip m-0 grid min-w-0 list-none p-0",
        metrics.length === 4
          ? "grid-cols-4 gap-2"
          : "grid-cols-2 gap-2",
        className,
      )}
      data-count={metrics.length}
      data-slot="inspector-metric-strip"
    >
      {metrics.map((metric) => {
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
