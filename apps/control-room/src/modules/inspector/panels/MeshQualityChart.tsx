"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  MeshQualityHistogramBin,
  MeshQualityMetric,
  MeshSizeDistribution,
} from "@/shared/domain/mesh/qualityStatistics";

/* ── Theming helpers ── */

const CHART_COLOR_TOKENS = {
  accent: "var(--fm-accent)",
  accentMuted: "color-mix(in srgb, var(--fm-accent) 35%, transparent)",
  borderSubtle: "var(--fm-border-subtle)",
  textMuted: "var(--fm-text-muted)",
  warning: "var(--fm-warning)",
} as const;

function getCSSVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function cssVarOrToken(name: string, fallback: string): string {
  return getCSSVar(name) || fallback;
}

function useChartColors() {
  return useMemo(
    () => ({
      accent: cssVarOrToken("--fm-accent", CHART_COLOR_TOKENS.accent),
      accentMuted: CHART_COLOR_TOKENS.accentMuted,
      borderSubtle: cssVarOrToken(
        "--fm-border-subtle",
        CHART_COLOR_TOKENS.borderSubtle,
      ),
      textMuted: cssVarOrToken("--fm-text-muted", CHART_COLOR_TOKENS.textMuted),
      warning: cssVarOrToken("--fm-warning", CHART_COLOR_TOKENS.warning),
    }),
    [],
  );
}

/* ── Tooltip ── */

interface BinPayload {
  binLabel: string;
  count: number;
  fraction: number;
}

function ChartTooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: BinPayload }>;
  [key: string]: unknown;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="fm-mesh-chart-tooltip">
      <span className="fm-mesh-chart-tooltip__label">{data.binLabel}</span>
      <span className="fm-mesh-chart-tooltip__value">
        {data.count.toLocaleString("en-US")} elements
      </span>
    </div>
  );
}

/* ── Tick formatters ── */

function shortLabel(label: string): string {
  const match = label.match(/^([\d.e+-]+)\s+to\s+([\d.e+-]+)$/i);
  if (match) return match[1];
  if (label.length > 8) return label.slice(0, 7) + "…";
  return label;
}

/* ── Bar color ── */

function barFill(
  bin: MeshQualityHistogramBin,
  threshold: number | null,
  accent: string,
  warning: string,
): string {
  if (threshold === null) return accent;
  if (bin.hi !== null && bin.hi <= threshold) return warning;
  if (bin.lo !== null && bin.lo >= threshold) return accent;
  return accent;
}

/* ── MetricHistogramChart ── */

interface MetricHistogramChartProps {
  metric: MeshQualityMetric;
}

export function MetricHistogramChart({ metric }: MetricHistogramChartProps) {
  const colors = useChartColors();
  const data = useMemo(
    () =>
      metric.histogram.map((bin) => ({
        binLabel: bin.label,
        count: bin.count,
        fill: barFill(bin, metric.threshold, colors.accent, colors.warning),
        fraction: bin.fraction,
        name: shortLabel(bin.label),
      })),
    [metric.histogram, metric.threshold, colors.accent, colors.warning],
  );

  if (data.length === 0) return null;

  return (
    <div
      aria-label={data
        .map((bin) => `${bin.binLabel}: ${bin.count.toLocaleString("en-US")}`)
        .join(", ")}
      className="fm-mesh-quality-chart"
      data-metric={metric.id}
    >
      <ResponsiveContainer width="100%" height={120}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
          barCategoryGap="12%"
        >
          <XAxis
            dataKey="name"
            tick={{ fill: colors.textMuted, fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: colors.borderSubtle }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: colors.textMuted, fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltipContent />}
            cursor={{ fill: colors.accentMuted, radius: 2 }}
          />
          {metric.threshold !== null ? (
            <ReferenceLine
              x={data.findIndex(
                (d) => {
                  const bin = metric.histogram[data.indexOf(d)];
                  return (
                    bin &&
                    bin.lo !== null &&
                    bin.hi !== null &&
                    bin.lo <= metric.threshold! &&
                    bin.hi >= metric.threshold!
                  );
                },
              ) === -1 ? undefined : data[
                data.findIndex((_, i) => {
                  const bin = metric.histogram[i];
                  return (
                    bin &&
                    bin.lo !== null &&
                    bin.hi !== null &&
                    bin.lo <= metric.threshold! &&
                    bin.hi >= metric.threshold!
                  );
                })
              ]?.name}
              stroke={colors.warning}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              label={{
                fill: colors.warning,
                fontSize: 9,
                position: "top",
                value: `threshold ${metric.threshold}`,
              }}
            />
          ) : null}
          <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={32}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} fillOpacity={0.82} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── SizeDistributionChart ── */

interface SizeDistributionChartProps {
  distribution: MeshSizeDistribution;
}

export function SizeDistributionChart({ distribution }: SizeDistributionChartProps) {
  const colors = useChartColors();
  const data = useMemo(
    () =>
      distribution.histogram.map((bin) => ({
        binLabel: bin.label,
        count: bin.count,
        fraction: bin.fraction,
        name: shortLabel(bin.label),
      })),
    [distribution.histogram],
  );

  if (data.length === 0) return null;

  return (
    <div
      aria-label={data
        .map((bin) => `${bin.binLabel}: ${bin.count.toLocaleString("en-US")}`)
        .join(", ")}
      className="fm-mesh-quality-chart"
      data-distribution={distribution.id}
    >
      <ResponsiveContainer width="100%" height={100}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
          barCategoryGap="12%"
        >
          <XAxis
            dataKey="name"
            tick={{ fill: colors.textMuted, fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: colors.borderSubtle }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: colors.textMuted, fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltipContent />}
            cursor={{ fill: colors.accentMuted, radius: 2 }}
          />
          <Bar
            dataKey="count"
            fill={colors.accent}
            fillOpacity={0.72}
            radius={[2, 2, 0, 0]}
            maxBarSize={32}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
