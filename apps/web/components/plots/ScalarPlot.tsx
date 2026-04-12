"use client";

/**
 * ScalarPlot – Plotly.js line chart for time-series data.
 *
 * Drop-in replacement for the previous ECharts implementation.
 * Uses react-plotly.js with dynamic import to avoid SSR issues in Next.js.
 *
 * Props: rows, xColumn, yColumns – same interface as the previous version.
 */

import { useMemo, memo } from "react";
import type { QuantityDescriptor, ScalarRow } from "../../lib/useSessionStream";
import Plot from "./DynamicPlot";
import { scalarSeriesList, type ScalarSeriesMeta } from "../../lib/quantities/scalars";
import { normalizeUnitLabel } from "../../lib/format";

// ─── Constants ──────────────────────────────────────────────────────

const SERIES_COLORS = [
  "#60a5fa", "#34d399", "#f472b6", "#fbbf24",
  "#a78bfa", "#fb923c", "#38bdf8", "#e879f9",
];

const DEFAULT_Y_COLUMNS = ["e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total"];

function isMagnetizationAverageColumn(col: string): boolean {
  return col === "mx" || col === "my" || col === "mz";
}

const accessor = (row: ScalarRow, key: string): number =>
  (row as unknown as Record<string, number>)[key] ?? 0;

// ─── Theme ──────────────────────────────────────────────────────────

const THEME = {
  bg: "transparent",
  paper: "transparent",
  text: "hsl(215, 20.2%, 65.1%)",      // muted-foreground
  gridLine: "hsla(217.2, 32.6%, 17.5%, 0.35)",
  hoverLabel: "hsl(222.2, 84%, 4.9%)",  // card bg
  hoverText: "hsl(210, 40%, 98%)",       // foreground
  hoverBorder: "hsl(217.2, 32.6%, 17.5%)",
} as const;

// ─── Props ──────────────────────────────────────────────────────────

interface Props {
  rows: ScalarRow[];
  quantities?: QuantityDescriptor[];
  xColumn?: string;
  yColumns?: string[];
}

// ─── Component ──────────────────────────────────────────────────────

const ScalarPlot = memo(function ScalarPlot({
  rows,
  quantities = [],
  xColumn = "time",
  yColumns = DEFAULT_Y_COLUMNS,
}: Props) {
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

  const xLabel = buildAxisLabel(xMeta);

  // Build Plotly traces (memoised on rows + column identity)
  const traces = useMemo(() => {
    return seriesMeta.map((series, i) => ({
      x: rows.map((r) => accessor(r, xColumn)),
      y: rows.map((r) => accessor(r, series.key)),
      type: "scattergl" as const,
      mode: "lines" as const,
      name: buildAxisLabel(series),
      line: {
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        width: 1.5,
      },
      hovertemplate: magnetizationOnly
        ? `%{y:.4f}<extra>${buildAxisLabel(series)}</extra>`
        : `%{y:.4e}<extra>${buildAxisLabel(series)}</extra>`,
    }));
  }, [rows, xColumn, seriesMeta, magnetizationOnly]);

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: THEME.paper,
      plot_bgcolor: THEME.bg,
      font: {
        family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        size: 11,
        color: THEME.text,
      },
      margin: { l: 72, r: 16, t: 8, b: 48 },
      xaxis: {
        title: { text: xLabel, standoff: 8 },
        color: THEME.text,
        gridcolor: THEME.gridLine,
        gridwidth: 1,
        zeroline: false,
        exponentformat: "e",
        tickformat: magnetizationOnly ? ".3f" : undefined,
      },
      yaxis: {
        title: {
          text: seriesMeta.length === 1 ? buildAxisLabel(seriesMeta[0]) : undefined,
          standoff: 8,
        },
        color: THEME.text,
        gridcolor: THEME.gridLine,
        gridwidth: 1,
        zeroline: false,
        exponentformat: "e",
        tickformat: magnetizationOnly ? ".2f" : undefined,
      },
      legend: {
        orientation: "h",
        yanchor: "top",
        y: -0.22,
        xanchor: "center",
        x: 0.5,
        font: { size: 11, color: THEME.text },
      },
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: THEME.hoverLabel,
        bordercolor: THEME.hoverBorder,
        font: { color: THEME.hoverText, size: 12 },
      },
      dragmode: "zoom",
      modebar: {
        bgcolor: "transparent",
        color: THEME.text,
        activecolor: "#60a5fa",
        orientation: "v",
      },
    }),
    [xLabel, magnetizationOnly, seriesMeta],
  );

  const config = useMemo(
    (): Partial<Plotly.Config> => ({
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: [
        "lasso2d",
        "select2d",
        "sendDataToCloud",
        "hoverCompareCartesian",
        "hoverClosestCartesian",
      ],
      toImageButtonOptions: {
        format: "png",
        filename: "fullmag_scalar_plot",
        scale: 2,
      },
    }),
    [],
  );

  return (
    <Plot
      data={traces}
      layout={layout}
      config={config}
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
