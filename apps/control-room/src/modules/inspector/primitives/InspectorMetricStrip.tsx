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
    <div
      className={cn(
        "fm-inspector-metric-strip grid min-w-0 grid-cols-2 gap-x-5 gap-y-3 border-b border-fm-subtle pb-4",
        className,
      )}
      data-count={metrics.length}
      data-slot="inspector-metric-strip"
      role="list"
    >
      {metrics.map((metric) => {
        const tone = metric.tone ?? "neutral";
        return (
          <div
            className="min-w-0"
            data-slot="inspector-metric"
            key={metric.label}
            role="listitem"
          >
            <span className="block text-fm-help font-medium leading-tight text-fm-muted">
              {metric.label}
            </span>
            <span
              className={cn(
                "mt-1 block min-w-0 truncate text-fm-control font-semibold leading-snug",
                toneClasses[tone],
              )}
              data-state={tone}
              title={typeof metric.value === "string" ? metric.value : undefined}
            >
              {metric.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
