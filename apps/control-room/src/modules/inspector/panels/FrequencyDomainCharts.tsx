"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import type {
  EigenDispersionPoint,
  EigenSpectrumPoint,
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

const Bar = dynamic(() => import("recharts").then((module) => module.Bar), {
  ssr: false,
});
const BarChart = dynamic(
  () => import("recharts").then((module) => module.BarChart),
  { ssr: false },
);
const CartesianGrid = dynamic(
  () => import("recharts").then((module) => module.CartesianGrid),
  { ssr: false },
);
const Legend = dynamic(() => import("recharts").then((module) => module.Legend), {
  ssr: false,
});
const Line = dynamic(() => import("recharts").then((module) => module.Line), {
  ssr: false,
});
const LineChart = dynamic(
  () => import("recharts").then((module) => module.LineChart),
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

const CHART_COLORS = [
  "var(--fm-chart-blue)",
  "var(--fm-chart-green)",
  "var(--fm-chart-yellow)",
  "var(--fm-chart-red)",
  "var(--fm-chart-mauve)",
] as const;

function formatGHz(valueHz: number): string {
  return `${formatNumber(valueHz / 1e9)} GHz`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(5)).toLocaleString("en-US");
}

function chartFrame({
  children,
  droppedPointCount,
  pointCount,
  renderer,
  title,
}: {
  children: ReactNode;
  droppedPointCount: number;
  pointCount: number;
  renderer: string;
  title: string;
}) {
  return (
    <div
      aria-label={title}
      className="fm-frequency-domain-chart"
      data-renderer={renderer}
    >
      <div className="fm-frequency-domain-chart__header">
        <span>{title}</span>
        <small>
          Recharts, {pointCount} points
          {droppedPointCount > 0 ? `, ${droppedPointCount} dropped` : ""}
        </small>
      </div>
      {pointCount > 0 ? (
        <div className="fm-frequency-domain-chart__canvas">{children}</div>
      ) : (
        <div className="fm-frequency-domain-chart__empty">
          No chartable frequency-domain samples.
        </div>
      )}
    </div>
  );
}

export function FrequencyDomainSpectrumChart({
  model,
}: {
  model: FrequencyDomainChartBuildResult<EigenSpectrumPoint>;
}) {
  const data = model.points.map((point) => ({
    dampingGHz:
      point.dampingRateHz == null ? null : Math.abs(point.dampingRateHz) / 1e9,
    frequencyGHz: point.frequencyHz / 1e9,
    frequencyLabel: formatGHz(point.frequencyHz),
    mode: point.rawModeIndex,
    name: `mode ${point.rawModeIndex}`,
    residualNorm: point.residualNorm,
    sample: point.sampleIndex,
  }));

  return chartFrame({
    droppedPointCount: model.droppedPointCount,
    pointCount: data.length,
    renderer: "recharts",
    title: "FMR / eigen modal spectrum",
    children: (
      <>
        <ResponsiveContainer height={180} width="100%">
          <BarChart data={data} margin={{ top: 12, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--fm-border-subtle)" strokeDasharray="3 3" />
            <XAxis
              axisLine={{ stroke: "var(--fm-border-strong)" }}
              dataKey="mode"
              name="mode"
              tick={{ fill: "var(--fm-text-muted)", fontSize: 10 }}
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              name="GHz"
              tick={{ fill: "var(--fm-text-muted)", fontSize: 10 }}
              tickFormatter={(value) =>
                typeof value === "number" ? formatNumber(value) : String(value)
              }
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "var(--fm-bg-panel-raised)",
                borderColor: "var(--fm-border-default)",
                borderRadius: "var(--fm-radius-md)",
                color: "var(--fm-text-primary)",
              }}
              formatter={(value) =>
                typeof value === "number" ? formatNumber(value) : String(value)
              }
              labelFormatter={(value) => `mode ${String(value)}`}
            />
            <Legend />
            <Bar
              dataKey="frequencyGHz"
              fill="var(--fm-chart-blue)"
              name="frequency [GHz]"
              radius={[5, 5, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
        <div className="fm-frequency-domain-chart__summary">
          {data.slice(0, 4).map((point) => (
            <span key={`${point.sample}:${point.mode}`}>
              mode {point.mode}: {point.frequencyLabel}
            </span>
          ))}
        </div>
      </>
    ),
  });
}

export function FrequencyDomainDispersionChart({
  model,
}: {
  model: FrequencyDomainChartBuildResult<EigenDispersionPoint>;
}) {
  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      series={model.series}
      title="Bloch / Floquet dispersion"
      xLabel="k-path s [rad/m]"
    />
  );
}

export function FrequencyDomainResponseChart({
  model,
}: {
  model: FrequencyDomainChartBuildResult<FrequencyResponsePoint>;
}) {
  return (
    <FrequencyDomainSeriesChart
      droppedPointCount={model.droppedPointCount}
      series={model.series}
      title="Driven FMR frequency response"
      xLabel="frequency [Hz]"
    />
  );
}

function FrequencyDomainSeriesChart({
  droppedPointCount,
  series,
  title,
  xLabel,
}: {
  droppedPointCount: number;
  series: readonly FrequencyDomainChartSeries[];
  title: string;
  xLabel: string;
}) {
  const chartSeries = series.filter((entry) => entry.points.length > 0);
  const rowsByX = new Map<number, Record<string, number | string>>();
  chartSeries.forEach((entry, seriesIndex) => {
    const key = `series${seriesIndex}`;
    entry.points.forEach((point) => {
      const row = rowsByX.get(point.x) ?? { x: point.x };
      row[key] = point.y;
      rowsByX.set(point.x, row);
    });
  });
  const data = [...rowsByX.values()].sort((a, b) => Number(a.x) - Number(b.x));
  const pointCount = chartSeries.reduce(
    (count, entry) => count + entry.points.length,
    0,
  );

  return chartFrame({
    droppedPointCount,
    pointCount,
    renderer: "recharts",
    title,
    children: (
      <>
        <ResponsiveContainer height={180} width="100%">
          <LineChart data={data} margin={{ top: 12, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--fm-border-subtle)" strokeDasharray="3 3" />
            <XAxis
              axisLine={{ stroke: "var(--fm-border-strong)" }}
              dataKey="x"
              name={xLabel}
              tick={{ fill: "var(--fm-text-muted)", fontSize: 10 }}
              tickFormatter={(value) =>
                typeof value === "number" ? formatNumber(value) : String(value)
              }
              tickLine={false}
              type="number"
            />
            <YAxis
              axisLine={false}
              tick={{ fill: "var(--fm-text-muted)", fontSize: 10 }}
              tickFormatter={(value) =>
                typeof value === "number" ? formatNumber(value) : String(value)
              }
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "var(--fm-bg-panel-raised)",
                borderColor: "var(--fm-border-default)",
                borderRadius: "var(--fm-radius-md)",
                color: "var(--fm-text-primary)",
              }}
              formatter={(value) =>
                typeof value === "number" ? formatNumber(value) : String(value)
              }
              labelFormatter={(value) => `${xLabel}: ${String(value)}`}
            />
            <Legend />
            {chartSeries.map((entry, index) => (
              <Line
                dataKey={`series${index}`}
                dot={false}
                key={entry.id}
                name={`${entry.label} [${entry.unit}]`}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={2}
                type="monotone"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div className="fm-frequency-domain-chart__summary">
          {chartSeries.slice(0, 4).map((entry) => (
            <span key={entry.id}>
              {entry.label}: {entry.points.length} samples
            </span>
          ))}
        </div>
      </>
    ),
  });
}
