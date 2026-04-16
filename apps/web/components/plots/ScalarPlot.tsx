"use client";

import { memo, useMemo } from "react";
import type { QuantityDescriptor, ScalarRow } from "../../lib/useSessionStream";
import Plot from "./DynamicPlot";
import { scalarSeriesList, type ScalarSeriesMeta } from "../../lib/quantities/scalars";
import { normalizeUnitLabel } from "../../lib/format";
import { scalarRowsTipFingerprint } from "@/lib/plots/scalarRows";

export const MAX_VISIBLE_POINTS = 2400;

const SERIES_COLORS = [
  "#60a5fa", "#34d399", "#f472b6", "#fbbf24",
  "#a78bfa", "#fb923c", "#38bdf8", "#e879f9",
];

const DEFAULT_Y_COLUMNS = ["e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total"];

function isMagnetizationAverageColumn(col: string): boolean {
  return col === "mx" || col === "my" || col === "mz";
}

const accessor = (row: ScalarRow, key: string): number => {
  const value = Reflect.get(row, key);
  return typeof value === "number" ? value : 0;
};

interface TimeScale {
  factor: number;
  unit: string;
  tickformat: string;
}

const TIME_SCALES: TimeScale[] = [
  { factor: 1e12, unit: "ps", tickformat: ".3g" },
  { factor: 1e9, unit: "ns", tickformat: ".3g" },
  { factor: 1e6, unit: "µs", tickformat: ".3g" },
  { factor: 1e3, unit: "ms", tickformat: ".3g" },
  { factor: 1, unit: "s", tickformat: ".4g" },
];

function chooseTimeScale(maxAbsSeconds: number): TimeScale {
  if (maxAbsSeconds <= 0) return TIME_SCALES[1];
  for (const scale of TIME_SCALES) {
    if (maxAbsSeconds * scale.factor >= 0.09) return scale;
  }
  return TIME_SCALES[TIME_SCALES.length - 1];
}

function fingerprintRevision(fingerprint: string): number {
  let hash = 0;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = (hash * 31 + fingerprint.charCodeAt(index)) >>> 0;
  }
  return hash;
}

const THEME = {
  bg: "transparent",
  paper: "transparent",
  text: "hsl(210, 40%, 96%)",
  axisText: "hsl(215, 20%, 78%)",
  gridLine: "rgba(148, 163, 184, 0.18)",
  zeroLine: "rgba(148, 163, 184, 0.28)",
  axisLine: "rgba(148, 163, 184, 0.32)",
  hoverLabel: "hsl(222.2, 84%, 4.9%)",
  hoverText: "hsl(210, 40%, 98%)",
  hoverBorder: "hsl(217.2, 32.6%, 17.5%)",
} as const;

interface Props {
  rows: ScalarRow[];
  quantities?: QuantityDescriptor[];
  xColumn?: string;
  yColumns?: string[];
  seriesColors?: string[];
  chartTitle?: string;
  uiRevisionKey?: string;
  yAxisScale?: "linear" | "log";
  showMarkers?: boolean;
  showRangeSlider?: boolean;
  alwaysShowModeBar?: boolean;
}

const ScalarPlot = memo(function ScalarPlot({
  rows,
  quantities = [],
  xColumn = "time",
  yColumns = DEFAULT_Y_COLUMNS,
  seriesColors,
  chartTitle,
  uiRevisionKey = "charts",
  yAxisScale = "linear",
  showMarkers = false,
  showRangeSlider = false,
  alwaysShowModeBar = false,
}: Props) {
  const rowsFingerprint = useMemo(() => scalarRowsTipFingerprint(rows), [rows]);
  const revision = useMemo(
    () => fingerprintRevision(rowsFingerprint),
    [rowsFingerprint],
  );

  const rowsForPlot = useMemo(() => {
    if (rows.length <= MAX_VISIBLE_POINTS) return rows;
    const stride = Math.ceil(rows.length / MAX_VISIBLE_POINTS);
    const sampled = rows.filter((_, index) => index % stride === 0);
    const last = rows[rows.length - 1];
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled;
  }, [rows]);

  const isTimeColumn = xColumn === "time";

  const xMeta = useMemo(
    () => scalarSeriesList([xColumn], quantities)[0] ?? { key: xColumn, label: xColumn, unit: "", kind: "diagnostic" as const },
    [quantities, xColumn],
  );

  const seriesMeta = useMemo(
    () => scalarSeriesList(yColumns, quantities),
    [quantities, yColumns],
  );

  const magnetizationOnly =
    seriesMeta.length > 0 && seriesMeta.every((meta) => isMagnetizationAverageColumn(meta.key));

  const timeScale = useMemo((): TimeScale | null => {
    if (!isTimeColumn || rowsForPlot.length === 0) return null;
    const maxT = rowsForPlot.reduce((max, r) => Math.max(max, Math.abs(accessor(r, "time"))), 0);
    return chooseTimeScale(maxT);
  }, [isTimeColumn, rowsForPlot]);

  const xValues = useMemo(() => {
    if (xColumn === "time" && timeScale) {
      return rowsForPlot.map((r) => accessor(r, "time") * timeScale.factor);
    }
    return rowsForPlot.map((r) => accessor(r, xColumn));
  }, [rowsForPlot, xColumn, timeScale]);

  const yByKey = useMemo(() => {
    const grouped = new Map<string, number[]>();
    for (const series of seriesMeta) {
      grouped.set(series.key, rowsForPlot.map((r) => accessor(r, series.key)));
    }
    return grouped;
  }, [rowsForPlot, seriesMeta]);

  const xLabel = useMemo(() => {
    if (timeScale) return `Time (${timeScale.unit})`;
    return buildAxisLabel(xMeta);
  }, [timeScale, xMeta]);

  const unitGroups = useMemo(() => {
    const grouped = new Map<string, string[]>();
    const unitByKey = new Map<string, string>();
    for (const series of seriesMeta) {
      const normalizedUnit = normalizeUnitLabel(series.unit) || "arb.";
      unitByKey.set(series.key, normalizedUnit);
      const existing = grouped.get(normalizedUnit) ?? [];
      existing.push(series.key);
      grouped.set(normalizedUnit, existing);
    }
    const orderedUnits = [...grouped.keys()];
    return {
      leftUnit: orderedUnits[0] ?? "",
      rightUnit: orderedUnits[1] ?? "",
      unitByKey,
    };
  }, [seriesMeta]);

  const traces = useMemo(() => {
    const mode =
      rowsForPlot.length > 1
        ? (showMarkers ? ("lines+markers" as const) : ("lines" as const))
        : ("markers" as const);

    return seriesMeta.map((series, i) => ({
      x: xValues,
      y: yByKey.get(series.key) ?? [],
      type: "scattergl" as const,
      mode,
      name: buildAxisLabel(series),
      yaxis:
        unitGroups.rightUnit &&
        unitGroups.unitByKey.get(series.key) === unitGroups.rightUnit
          ? "y2"
          : "y",
      line: {
        color: seriesColors?.[i] ?? SERIES_COLORS[i % SERIES_COLORS.length],
        width: 1.5,
      },
      marker: {
        color: seriesColors?.[i] ?? SERIES_COLORS[i % SERIES_COLORS.length],
        size: rowsForPlot.length > 1 ? (showMarkers ? 4 : 0) : 7,
      },
      hovertemplate: magnetizationOnly
        ? `%{y:.4f}<extra>${buildAxisLabel(series)}</extra>`
        : `%{y:.4e}<extra>${buildAxisLabel(series)}</extra>`,
    }));
  }, [
    xValues,
    yByKey,
    rowsForPlot.length,
    seriesMeta,
    magnetizationOnly,
    seriesColors,
    showMarkers,
    unitGroups,
  ]);

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: THEME.paper,
      plot_bgcolor: THEME.bg,
      font: {
        family:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        size: 12,
        color: THEME.axisText,
      },
      title: chartTitle
        ? {
            text: chartTitle,
            font: { size: 14, color: THEME.text, weight: 600 },
            x: 0.5,
            xanchor: "center" as const,
            y: 0.97,
          }
        : undefined,
      margin: {
        l: 60,
        r: unitGroups.rightUnit ? 70 : 26,
        t: traces.length > 1 ? (chartTitle ? 70 : 52) : (chartTitle ? 42 : 20),
        b: showRangeSlider ? 88 : 46,
        pad: 4,
      },
      xaxis: {
        title: { text: xLabel, standoff: 14, font: { size: 12, color: THEME.axisText } },
        color: THEME.axisText,
        showgrid: true,
        gridcolor: THEME.gridLine,
        gridwidth: 1,
        griddash: "dot",
        zeroline: true,
        zerolinecolor: THEME.zeroLine,
        zerolinewidth: 1,
        automargin: true,
        showline: true,
        linecolor: THEME.axisLine,
        tickfont: { size: 11, color: THEME.axisText },
        exponentformat: timeScale ? "none" : "e",
        showspikes: true,
        spikemode: "across",
        spikethickness: 1,
        spikecolor: "rgba(96,165,250,0.45)",
        rangeslider: showRangeSlider && rowsForPlot.length > 2
          ? {
              visible: true,
              thickness: 0.08,
              bgcolor: "rgba(15,23,42,0.45)",
              bordercolor: THEME.axisLine,
            }
          : undefined,
        tickformat: timeScale
          ? timeScale.tickformat
          : magnetizationOnly ? ".3f" : undefined,
      },
      yaxis: {
        title: {
          text:
            seriesMeta.length === 1
              ? buildAxisLabel(seriesMeta[0])
              : unitGroups.leftUnit
                ? `Value (${unitGroups.leftUnit})`
                : "Value",
          standoff: 12,
          font: { size: 12, color: THEME.axisText }
        },
        color: THEME.axisText,
        showgrid: true,
        gridcolor: THEME.gridLine,
        gridwidth: 1,
        griddash: "dot",
        zeroline: true,
        zerolinecolor: THEME.zeroLine,
        zerolinewidth: 1,
        automargin: true,
        showline: true,
        linecolor: THEME.axisLine,
        tickfont: { size: 11, color: THEME.axisText },
        type: yAxisScale,
        showspikes: true,
        spikemode: "across",
        spikethickness: 1,
        spikecolor: "rgba(96,165,250,0.4)",
        exponentformat: "e",
        tickformat: magnetizationOnly ? ".2f" : undefined,
      },
      yaxis2: unitGroups.rightUnit
        ? {
            title: {
              text: `Value (${unitGroups.rightUnit})`,
              standoff: 12,
              font: { size: 12, color: THEME.axisText }
            },
            overlaying: "y",
            side: "right",
            color: THEME.axisText,
            showgrid: false,
            zeroline: false,
            automargin: true,
            showline: true,
            linecolor: THEME.axisLine,
            tickfont: { size: 11, color: THEME.axisText },
            type: yAxisScale,
            exponentformat: "e",
          }
        : undefined,
      showlegend: traces.length > 1,
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "left",
        x: 0,
        font: { size: 11, color: THEME.axisText },
        bgcolor: "rgba(8, 12, 24, 0.72)",
        bordercolor: "rgba(148, 163, 184, 0.18)",
        borderwidth: 1,
      },
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: THEME.hoverLabel,
        bordercolor: THEME.hoverBorder,
        font: { color: THEME.hoverText, size: 12 },
        namelength: -1,
      },
      dragmode: "pan",
      uirevision: `scalar-plot:${uiRevisionKey}`,
      modebar: {
        bgcolor: "transparent",
        color: THEME.axisText,
        activecolor: "#60a5fa",
        orientation: "v",
      },
    }),
    [
      xLabel,
      magnetizationOnly,
      seriesMeta,
      chartTitle,
      timeScale,
      unitGroups.leftUnit,
      unitGroups.rightUnit,
      uiRevisionKey,
      rowsForPlot.length,
      traces.length,
      showRangeSlider,
      yAxisScale,
    ],
  );

  const config = useMemo(
    (): Partial<Plotly.Config> => {
      const nextConfig: Partial<Plotly.Config> = {
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
        doubleClick: "reset+autosize",
        modeBarButtonsToRemove: ["sendDataToCloud"],
        toImageButtonOptions: {
          format: "png",
          filename: "fullmag_scalar_plot",
          scale: 2,
        },
      };
      if (alwaysShowModeBar) {
        nextConfig.displayModeBar = true;
      }
      return nextConfig;
    },
    [alwaysShowModeBar],
  );

  return (
    <Plot
      key={`scalar-plot:${uiRevisionKey}`}
      data={traces}
      layout={layout}
      config={config}
      revision={revision}
      useResizeHandler
      className="h-full w-full"
      style={{ width: "100%", height: "100%" }}
    />
  );
});

export default ScalarPlot;

function buildAxisLabel(meta: ScalarSeriesMeta): string {
  const unit = normalizeUnitLabel(meta.unit);
  return unit ? `${meta.label} (${unit})` : meta.label;
}
