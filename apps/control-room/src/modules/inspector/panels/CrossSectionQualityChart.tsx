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

function getCSSVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function CrossSectionQualityChart({
  bins,
  totalCount,
}: {
  bins: readonly CrossSectionHistogramBin[];
  totalCount: number;
}) {
  const colors = useMemo(() => ({
    bar: getCSSVar("--fm-accent", "#89b4fa"),
    text: getCSSVar("--fm-text-muted", "#6c7086"),
    grid: getCSSVar("--fm-border-subtle", "#313244"),
    tooltipBg: getCSSVar("--fm-bg-panel-raised", "#313244"),
    tooltipBorder: getCSSVar("--fm-border-subtle", "#313244"),
    tooltipText: getCSSVar("--fm-text-primary", "#cdd6f4"),
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
            contentStyle={{
              background: colors.tooltipBg,
              border: `1px solid ${colors.tooltipBorder}`,
              borderRadius: "var(--fm-radius-sm)",
              color: colors.tooltipText,
              fontSize: "11px",
              fontFamily: "var(--fm-font-mono)",
            }}
            labelStyle={{ color: colors.tooltipText, fontWeight: 600 }}
            formatter={(value: unknown, _name: unknown, entry: unknown) => {
              const v = typeof value === "number" ? value : 0;
              const pct = (entry as { payload?: { pct?: string } })?.payload?.pct ?? "0";
              return [`${v} elements (${pct}%)`, "Count"];
            }}
          />
          <Bar dataKey="count" fill={colors.bar} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
