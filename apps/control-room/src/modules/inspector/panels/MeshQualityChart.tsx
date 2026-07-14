"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef } from "react";

import type {
  MeshQualityHistogramBin,
  MeshQualityMetric,
  MeshSizeDistribution,
} from "@/shared/domain/mesh/qualityStatistics";

import {
  buildMeshSizeDistributionHoverBin,
  meshSizeDistributionHoverKey,
  resolveActiveHistogramBinIndex,
} from "./meshHistogramHoverState";

const Bar = dynamic(() => import("recharts").then((module) => module.Bar), {
  ssr: false,
});
const BarChart = dynamic(
  () => import("recharts").then((module) => module.BarChart),
  { ssr: false },
);
const Cell = dynamic(() => import("recharts").then((module) => module.Cell), {
  ssr: false,
});
const ReferenceLine = dynamic(
  () => import("recharts").then((module) => module.ReferenceLine),
  { ssr: false },
);
const ResponsiveContainer = dynamic(
  () => import("recharts").then((module) => module.ResponsiveContainer),
  { ssr: false },
);
const Tooltip = dynamic(
  () => import("recharts").then((module) => module.Tooltip),
  { ssr: false },
);
const XAxis = dynamic(() => import("recharts").then((module) => module.XAxis), {
  ssr: false,
});
const YAxis = dynamic(() => import("recharts").then((module) => module.YAxis), {
  ssr: false,
});

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
  return {
    accent: cssVarOrToken("--fm-accent", CHART_COLOR_TOKENS.accent),
    accentMuted: CHART_COLOR_TOKENS.accentMuted,
    borderSubtle: cssVarOrToken(
      "--fm-border-subtle",
      CHART_COLOR_TOKENS.borderSubtle,
    ),
    textMuted: cssVarOrToken("--fm-text-muted", CHART_COLOR_TOKENS.textMuted),
    warning: cssVarOrToken("--fm-warning", CHART_COLOR_TOKENS.warning),
  };
}

/* ── Tooltip ── */

interface BinPayload {
  binIndex?: number;
  binLabel: string;
  count: number;
  fraction: number;
}

export interface MeshSizeDistributionHoverBin {
  binIndex: number;
  binLabel: string;
  count: number;
  distributionId: MeshSizeDistribution["id"];
  distributionLabel: string;
  fraction: number;
  hi: number | null;
  lo: number | null;
}

function formatSizeMarkerValue(value: number | null): string {
  if (value === null) return "unknown";
  const abs = Math.abs(value);
  if (abs > 0 && (abs < 1e-3 || abs >= 1e4)) {
    return value.toExponential(2);
  }
  return value.toPrecision(3);
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
  const percent =
    typeof data.fraction === "number"
      ? (data.fraction * 100).toFixed(1)
      : null;
  return (
    <div className="fm-mesh-chart-tooltip">
      <span className="fm-mesh-chart-tooltip__label">{data.binLabel}</span>
      <span className="fm-mesh-chart-tooltip__value">
        {data.count.toLocaleString("en-US")} elements
        {percent !== null ? ` (${percent}%)` : ""}
      </span>
    </div>
  );
}

function SizeDistributionTooltipContent({
  active,
  activeIndex,
  distribution,
  onHoverBin,
  payload,
}: {
  active?: boolean;
  activeIndex?: number | string;
  distribution: MeshSizeDistribution;
  onHoverBin?: (bin: MeshSizeDistributionHoverBin | null) => void;
  payload?: ReadonlyArray<{ payload?: BinPayload }>;
}) {
  const activeIndexFromTooltip = resolveActiveHistogramBinIndex(
    {
      activeTooltipIndex: activeIndex,
      isTooltipActive: active ?? false,
    },
    distribution.histogram.length,
  );
  const activeIndexFromPayload =
    typeof payload?.[0]?.payload?.binIndex === "number"
      ? payload[0].payload.binIndex
      : null;
  const index = activeIndexFromTooltip ?? activeIndexFromPayload;
  const hoverBin = useMemo(
    () =>
      index === null
        ? null
        : buildMeshSizeDistributionHoverBin(distribution, index),
    [distribution, index],
  );
  const hoverKey = meshSizeDistributionHoverKey(hoverBin);
  const lastEmittedHoverKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onHoverBin) {
      return;
    }
    if (lastEmittedHoverKeyRef.current === hoverKey) {
      return;
    }
    lastEmittedHoverKeyRef.current = hoverKey;
    onHoverBin(hoverBin);
  }, [hoverBin, hoverKey, onHoverBin]);

  return <ChartTooltipContent active={active} payload={payload} />;
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
        fill: barFill(
          bin,
          metric.threshold,
          "url(#accentGradient)",
          "url(#warningGradient)",
        ),
        fraction: bin.fraction,
        name: shortLabel(bin.label),
      })),
    [metric.histogram, metric.threshold],
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
          <defs>
            <linearGradient id="accentGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.accent} stopOpacity={0.95} />
              <stop offset="100%" stopColor={colors.accent} stopOpacity={0.35} />
            </linearGradient>
            <linearGradient id="warningGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.warning} stopOpacity={0.95} />
              <stop offset="100%" stopColor={colors.warning} stopOpacity={0.35} />
            </linearGradient>
          </defs>
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
          <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={32}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} fillOpacity={0.85} />
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
  onHoverBin?: (bin: MeshSizeDistributionHoverBin | null) => void;
}

export function SizeDistributionChart({
  distribution,
  onHoverBin,
}: SizeDistributionChartProps) {
  const colors = useChartColors();
  const data = useMemo(
    () =>
      distribution.histogram.map((bin, binIndex) => ({
        binIndex,
        binLabel: bin.label,
        count: bin.count,
        fraction: bin.fraction,
        hi: bin.hi,
        lo: bin.lo,
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
      data-hoverable={onHoverBin ? "true" : "false"}
      onMouseLeave={() => onHoverBin?.(null)}
    >
      <ResponsiveContainer width="100%" height={100}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
          barCategoryGap="12%"
        >
          <defs>
            <linearGradient id="accentGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.accent} stopOpacity={0.95} />
              <stop offset="100%" stopColor={colors.accent} stopOpacity={0.35} />
            </linearGradient>
          </defs>
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
            content={
              <SizeDistributionTooltipContent
                distribution={distribution}
                onHoverBin={onHoverBin}
              />
            }
            cursor={{ fill: colors.accentMuted, radius: 2 }}
          />
          <ReferenceLine
            x={data[0]?.name}
            stroke={colors.warning}
            strokeDasharray="3 3"
            strokeWidth={1}
            label={{
              fill: colors.warning,
              fontSize: 9,
              position: "insideTopLeft",
              value: `min ${formatSizeMarkerValue(distribution.min)}`,
            }}
          />
          <ReferenceLine
            x={data[data.length - 1]?.name}
            stroke={colors.warning}
            strokeDasharray="3 3"
            strokeWidth={1}
            label={{
              fill: colors.warning,
              fontSize: 9,
              position: "insideTopRight",
              value: `max ${formatSizeMarkerValue(distribution.max)}`,
            }}
          />
          <Bar
            dataKey="count"
            fill="url(#accentGradient)"
            radius={[4, 4, 0, 0]}
            maxBarSize={32}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
