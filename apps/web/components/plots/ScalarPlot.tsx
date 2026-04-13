"use client";

/**
 * ScalarPlot – Plotly.js line chart for time-series data.
 *
 * Performance-critical: during live simulation the upstream store pushes
 * new `rows` on every WS tick (~60 Hz).  We throttle visual updates to
 * ≤3 fps by tracking a `revision` counter that only bumps every
 * THROTTLE_MS.  Plotly.react() is called only when `revision` changes,
 * avoiding expensive full re-renders.
 *
 * Automatic X-axis time scaling: raw time values (seconds) are normalised
 * to the most readable SI prefix (ps, ns, µs, ms, s) based on the data
 * range.
 */

import { useMemo, useRef, memo, useEffect, useState } from "react";
import type { QuantityDescriptor, ScalarRow } from "../../lib/useSessionStream";
import Plot from "./DynamicPlot";
import { scalarSeriesList, type ScalarSeriesMeta } from "../../lib/quantities/scalars";
import { normalizeUnitLabel } from "../../lib/format";

// ─── Constants ──────────────────────────────────────────────────────

/** Minimum interval (ms) between chart re-draws during live streaming. */
const THROTTLE_MS = 350;
const MAX_VISIBLE_POINTS = 2400;

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

// ─── Time auto-scaling ───────────────────────────────────────────────

interface TimeScale {
  factor: number;
  unit: string;
  tickformat: string;
}

const TIME_SCALES: TimeScale[] = [
  { factor: 1e12, unit: "ps",  tickformat: ".3g" },
  { factor: 1e9,  unit: "ns",  tickformat: ".3g" },
  { factor: 1e6,  unit: "µs",  tickformat: ".3g" },
  { factor: 1e3,  unit: "ms",  tickformat: ".3g" },
  { factor: 1,    unit: "s",   tickformat: ".4g" },
];

function chooseTimeScale(maxAbsSeconds: number): TimeScale {
  if (maxAbsSeconds <= 0) return TIME_SCALES[1];
  for (const scale of TIME_SCALES) {
    if (maxAbsSeconds * scale.factor >= 0.09) return scale;
  }
  return TIME_SCALES[TIME_SCALES.length - 1];
}

// ─── Theme ──────────────────────────────────────────────────────────

const THEME = {
  bg: "transparent",
  paper: "transparent",
  text: "hsl(215, 20.2%, 65.1%)",
  gridLine: "hsla(217.2, 32.6%, 17.5%, 0.35)",
  hoverLabel: "hsl(222.2, 84%, 4.9%)",
  hoverText: "hsl(210, 40%, 98%)",
  hoverBorder: "hsl(217.2, 32.6%, 17.5%)",
} as const;

// ─── Props ──────────────────────────────────────────────────────────

interface Props {
  rows: ScalarRow[];
  quantities?: QuantityDescriptor[];
  xColumn?: string;
  yColumns?: string[];
  seriesColors?: string[];
  chartTitle?: string;
  uiRevisionKey?: string;
}

// ─── Throttle hook ──────────────────────────────────────────────────

/**
 * Accepts a fast-changing value and returns a throttled version that
 * updates at most once every `intervalMs`.  This prevents Plotly from
 * re-rendering on every WS tick.
 */
function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdate = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdate.current;

    if (elapsed >= intervalMs) {
      // Enough time passed — update immediately
      lastUpdate.current = now;
      setThrottled(value);
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
      }
    } else if (!pending.current) {
      // Schedule a trailing update
      pending.current = setTimeout(() => {
        lastUpdate.current = Date.now();
        setThrottled(value);
        pending.current = null;
      }, intervalMs - elapsed);
    }

    return () => {
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
      }
    };
  }, [value, intervalMs]);

  return throttled;
}

// ─── Component ──────────────────────────────────────────────────────

const ScalarPlot = memo(function ScalarPlot({
  rows,
  quantities = [],
  xColumn = "time",
  yColumns = DEFAULT_Y_COLUMNS,
  seriesColors,
  chartTitle,
  uiRevisionKey = "charts",
}: Props) {
  // ── Throttle rows to ≤3 fps ──
  const throttledRows = useThrottledValue(rows, THROTTLE_MS);
  const revision = useRef(0);
  const prevRowCount = useRef(0);

  // Bump revision only when the throttled snapshot actually changed
  if (throttledRows.length !== prevRowCount.current) {
    prevRowCount.current = throttledRows.length;
    revision.current += 1;
  }

  const rowsForPlot = useMemo(() => {
    if (throttledRows.length <= MAX_VISIBLE_POINTS) return throttledRows;
    const stride = Math.ceil(throttledRows.length / MAX_VISIBLE_POINTS);
    const sampled = throttledRows.filter((_, index) => index % stride === 0);
    const last = throttledRows[throttledRows.length - 1];
    if (sampled[sampled.length - 1] !== last) {
      sampled.push(last);
    }
    return sampled;
  }, [throttledRows]);

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

  // ── Auto-scale time axis ──────────────────────────────────────────
  const timeScale = useMemo((): TimeScale | null => {
    if (!isTimeColumn || rowsForPlot.length === 0) return null;
    const maxT = rowsForPlot.reduce((max, r) => Math.max(max, Math.abs(accessor(r, "time"))), 0);
    return chooseTimeScale(maxT);
  }, [isTimeColumn, rowsForPlot]);

  // X values: apply time factor when applicable
  const xValues = useMemo(() => {
    if (!timeScale) {
      return rowsForPlot.map((r) => accessor(r, xColumn));
    }
    return rowsForPlot.map((r) => accessor(r, "time") * timeScale.factor);
  }, [rowsForPlot, xColumn, timeScale]);

  // Axis label
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
      orderedUnits,
      leftUnit: orderedUnits[0] ?? "",
      rightUnit: orderedUnits[1] ?? "",
      unitByKey,
    };
  }, [seriesMeta]);

  // Build Plotly traces
  const traces = useMemo(() => {
    const mode = rowsForPlot.length > 1 ? ("lines" as const) : ("markers" as const);

    return seriesMeta.map((series, i) => ({
      x: xValues,
      y: rowsForPlot.map((r) => accessor(r, series.key)),
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
        size: rowsForPlot.length > 1 ? 0 : 7,
      },
      hovertemplate: magnetizationOnly
        ? `%{y:.4f}<extra>${buildAxisLabel(series)}</extra>`
        : `%{y:.4e}<extra>${buildAxisLabel(series)}</extra>`,
    }));
  }, [xValues, rowsForPlot, seriesMeta, magnetizationOnly, seriesColors, unitGroups]);

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: THEME.paper,
      plot_bgcolor: THEME.bg,
      font: {
        family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        size: 11,
        color: THEME.text,
      },
      title: chartTitle
        ? { text: chartTitle, font: { size: 13, color: THEME.text }, x: 0.5, xanchor: "center" as const, y: 0.98 }
        : undefined,
      margin: { l: 72, r: 16, t: chartTitle ? 32 : 8, b: 48 },
      xaxis: {
        title: { text: xLabel, standoff: 8 },
        color: THEME.text,
        gridcolor: THEME.gridLine,
        gridwidth: 1,
        zeroline: false,
        exponentformat: timeScale ? "none" : "e",
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
          standoff: 8,
        },
        color: THEME.text,
        gridcolor: THEME.gridLine,
        gridwidth: 1,
        griddash: "dot",
        zeroline: false,
        exponentformat: "e",
        tickformat: magnetizationOnly ? ".2f" : undefined,
      },
      yaxis2: unitGroups.rightUnit
        ? {
            title: {
              text: `Value (${unitGroups.rightUnit})`,
              standoff: 8,
            },
            overlaying: "y",
            side: "right",
            color: THEME.text,
            showgrid: false,
            zeroline: false,
            exponentformat: "e",
          }
        : undefined,
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
        namelength: -1,
      },
      dragmode: "zoom",
      uirevision: uiRevisionKey,
      datarevision: revision.current,
      modebar: {
        bgcolor: "transparent",
        color: THEME.text,
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
      revision.current,
    ],
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
      revision={revision.current}
      useResizeHandler
      className="h-full w-full"
    />
  );
});

export default ScalarPlot;

function buildAxisLabel(meta: ScalarSeriesMeta): string {
  const unit = normalizeUnitLabel(meta.unit);
  return unit ? `${meta.label} (${unit})` : meta.label;
}
