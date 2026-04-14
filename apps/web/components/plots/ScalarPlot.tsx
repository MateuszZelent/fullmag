"use client";

/**
 * ScalarPlot – Plotly.js line chart for time-series data.
 *
 * Performance-critical: during live simulation the upstream store pushes
 * new `rows` on every poll cycle.  We throttle visual updates to
 * ≤3 fps by tracking a `revision` counter that only bumps every
 * THROTTLE_MS.  Plotly.react() is called only when `revision` changes,
 * avoiding expensive full re-renders.
 *
 * Incremental trace building: x/y arrays are cached and extended
 * (append-only) when the row set grows monotonically, avoiding full
 * O(N) rebuilds on every render cycle.
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

const accessor = (row: ScalarRow, key: string): number => {
  const value = Reflect.get(row, key);
  return typeof value === "number" ? value : 0;
};

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

// ─── Incremental trace cache ────────────────────────────────────────

interface TraceCache {
  /** Length of rowsForPlot when last computed. */
  rowCount: number;
  /** Last step value — used to detect pure appends vs resets. */
  lastStep: number;
  /** Cached x-values array. */
  xValues: number[];
  /** Cached y-values per series key. */
  yByKey: Map<string, number[]>;
  /** Time scale factor used for x-values. */
  timeScaleFactor: number;
  /** X column used. */
  xColumn: string;
}

/**
 * Build x/y trace arrays incrementally.
 *
 * When the row set grows monotonically (pure append), only the new rows
 * are mapped and pushed onto the cached arrays.  When a reset, downsample
 * stride change, or config change is detected, a full rebuild is done.
 */
function useIncrementalTraces(
  rowsForPlot: ScalarRow[],
  seriesMeta: ScalarSeriesMeta[],
  xColumn: string,
  timeScale: TimeScale | null,
): { xValues: number[]; yByKey: Map<string, number[]> } {
  const cacheRef = useRef<TraceCache | null>(null);

  return useMemo(() => {
    const timeScaleFactor = timeScale?.factor ?? 1;
    const isTime = xColumn === "time" && timeScale != null;
    const cache = cacheRef.current;

    const currentLastStep = rowsForPlot.length > 0
      ? (rowsForPlot[rowsForPlot.length - 1]?.step ?? -1)
      : -1;

    // Check if we can do an incremental append
    const canAppend =
      cache != null &&
      cache.xColumn === xColumn &&
      cache.timeScaleFactor === timeScaleFactor &&
      cache.rowCount > 0 &&
      rowsForPlot.length >= cache.rowCount &&
      currentLastStep >= cache.lastStep &&
      // Verify the prefix is unchanged by checking the old last row
      rowsForPlot.length > 0 &&
      cache.rowCount <= rowsForPlot.length;

    if (canAppend && cache != null) {
      const startIdx = cache.rowCount;
      const newCount = rowsForPlot.length - startIdx;

      if (newCount === 0) {
        // No new rows — return cached arrays directly (stable reference)
        return { xValues: cache.xValues, yByKey: cache.yByKey };
      }

      // Extend x-values
      const xValues = cache.xValues;
      for (let i = startIdx; i < rowsForPlot.length; i++) {
        const row = rowsForPlot[i];
        xValues.push(isTime ? accessor(row, "time") * timeScaleFactor : accessor(row, xColumn));
      }

      // Extend y-values per series
      const yByKey = cache.yByKey;
      for (const series of seriesMeta) {
        let arr = yByKey.get(series.key);
        if (!arr) {
          // New series added — full compute
          arr = rowsForPlot.map((r) => accessor(r, series.key));
          yByKey.set(series.key, arr);
        } else {
          for (let i = startIdx; i < rowsForPlot.length; i++) {
            arr.push(accessor(rowsForPlot[i], series.key));
          }
        }
      }

      cache.rowCount = rowsForPlot.length;
      cache.lastStep = currentLastStep;
      return { xValues, yByKey };
    }

    // Full rebuild
    const xValues: number[] = isTime
      ? rowsForPlot.map((r) => accessor(r, "time") * timeScaleFactor)
      : rowsForPlot.map((r) => accessor(r, xColumn));

    const yByKey = new Map<string, number[]>();
    for (const series of seriesMeta) {
      yByKey.set(series.key, rowsForPlot.map((r) => accessor(r, series.key)));
    }

    cacheRef.current = {
      rowCount: rowsForPlot.length,
      lastStep: currentLastStep,
      xValues,
      yByKey,
      timeScaleFactor,
      xColumn,
    };

    return { xValues, yByKey };
  }, [rowsForPlot, seriesMeta, xColumn, timeScale]);
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

  // ── Incremental x/y trace arrays ─────────────────────────────────
  const { xValues, yByKey } = useIncrementalTraces(rowsForPlot, seriesMeta, xColumn, timeScale);

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

  // Build Plotly traces — uses incremental x/y arrays
  const traces = useMemo(() => {
    const mode = rowsForPlot.length > 1 ? ("lines" as const) : ("markers" as const);

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
        size: rowsForPlot.length > 1 ? 0 : 7,
      },
      hovertemplate: magnetizationOnly
        ? `%{y:.4f}<extra>${buildAxisLabel(series)}</extra>`
        : `%{y:.4e}<extra>${buildAxisLabel(series)}</extra>`,
    }));
  }, [xValues, yByKey, rowsForPlot.length, seriesMeta, magnetizationOnly, seriesColors, unitGroups]);

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
