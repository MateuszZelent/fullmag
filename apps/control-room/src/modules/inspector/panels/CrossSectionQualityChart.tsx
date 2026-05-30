"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";

const BarChart = dynamic(() => import("recharts").then((m) => m.BarChart), { ssr: false });
const Bar = dynamic(() => import("recharts").then((m) => m.Bar), { ssr: false });
const XAxis = dynamic(() => import("recharts").then((m) => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import("recharts").then((m) => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import("recharts").then((m) => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import("recharts").then((m) => m.ResponsiveContainer), { ssr: false });

interface CrossSectionHistogramBin {
  lo: number;
  hi: number;
  label: string;
  count: number;
}

interface BinPayload {
  name: string;
  count: number;
  pct: string;
}

function cssVar(name: string): string {
  return `var(${name})`;
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
      <span className="fm-mesh-chart-tooltip__label">{data.name}</span>
      <span className="fm-mesh-chart-tooltip__value">
        {data.count.toLocaleString("en-US")} elements ({data.pct}%)
      </span>
    </div>
  );
}

export function CrossSectionQualityChart({
  bins,
  totalCount,
}: {
  bins: readonly CrossSectionHistogramBin[];
  totalCount: number;
}) {
  const colors = useMemo(() => ({
    bar: cssVar("--fm-accent"),
    barMuted: "color-mix(in srgb, var(--fm-accent) 35%, transparent)",
    text: cssVar("--fm-text-muted"),
    grid: cssVar("--fm-border-subtle"),
  }), []);

  if (bins.length === 0) return null;

  const data = bins.map((bin) => ({
    name: bin.label,
    count: bin.count,
    pct: totalCount > 0 ? ((bin.count / totalCount) * 100).toFixed(1) : "0",
  }));

  return (
    <div className="fm-mesh-quality-chart" aria-label={`Quality histogram with ${bins.length} bins`}>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="crossSectionAccentGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.bar} stopOpacity={0.95} />
              <stop offset="100%" stopColor={colors.bar} stopOpacity={0.35} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="name"
            tick={{ fontSize: 9, fill: colors.text }}
            axisLine={{ stroke: colors.grid }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 9, fill: colors.text }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltipContent />}
            cursor={{ fill: colors.barMuted, radius: 2 }}
          />
          <Bar dataKey="count" fill="url(#crossSectionAccentGradient)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
