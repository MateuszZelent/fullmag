"use client";

/**
 * ChartsViewport — Plotly-based scalar telemetry workbench.
 *
 * Data source today:
 * - live window: `scalar_rows` streamed via the current workspace transport
 * - full history: lazy fetch from `GET /v1/live/current/scalars`
 * - on-disk artifact: `scalars.csv`
 *
 * Zarr is used for spatial field snapshots, not for scalar chart traces.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CircleDot, Download, RefreshCcw } from "lucide-react";

import ScalarPlot from "@/components/plots/ScalarPlot";
import ChartQuantitySelector from "@/components/plots/ChartQuantitySelector";
import { extractSamplingSummary } from "@/components/plots/chartSampling";
import {
  DEFAULT_CHART_STATE,
  type ChartState,
  resolveSeriesEntry,
  seriesColor,
  buildQuantityGroups,
  extendEntryMap,
} from "@/components/plots/chartTypes";
import { Button } from "@/components/ui/button";
import { useChartPersistence } from "@/hooks/useChartPersistence";
import { useScalarChartHistory } from "@/hooks/useScalarChartHistory";
import { fmtExp, fmtSI, fmtTime } from "@/lib/format";
import { serializeScalarRowsCsv } from "@/lib/plots/scalarRows";
import type { ScalarRow } from "@/lib/session/types";
import { cn } from "@/lib/utils";

import { useCommand, useModel, useTransport } from "./ControlRoomContext";

type AxisScaleMode = "linear" | "log";

interface SeriesStats {
  key: string;
  label: string;
  unit: string;
  color: string;
  latestValue: number | null;
  deltaValue: number | null;
  minValue: number | null;
  maxValue: number | null;
}

function scalarValue(row: ScalarRow, key: string): number | null {
  const value = Reflect.get(row, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isMagnetizationSeries(quantityKey: string): boolean {
  return quantityKey === "mx" || quantityKey === "my" || quantityKey === "mz";
}

function formatSeriesValue(value: number | null, unit: string, quantityKey: string): string {
  if (value == null) {
    return "—";
  }
  if (!unit && isMagnetizationSeries(quantityKey)) {
    return value.toFixed(4);
  }
  return unit ? fmtSI(value, unit, quantityKey) : fmtExp(value);
}

function formatSeriesDelta(value: number | null, unit: string, quantityKey: string): string {
  if (value == null) {
    return "—";
  }
  if (!unit && isMagnetizationSeries(quantityKey)) {
    return value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
  }
  if (!unit) {
    return value >= 0 ? `+${fmtExp(value)}` : fmtExp(value);
  }
  const formatted = fmtSI(value, unit, quantityKey);
  return value >= 0 ? `+${formatted}` : formatted;
}

function sanitizeFilenameSegment(value: string | null | undefined): string {
  const trimmed = value?.trim() || "fullmag";
  return trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "fullmag";
}

function downloadTextFile(filename: string, content: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function statsForSeries(rows: ScalarRow[], keys: string[]): SeriesStats[] {
  return keys.map((key, index) => {
    const entry = resolveSeriesEntry(key);
    const values = rows
      .map((row) => scalarValue(row, key))
      .filter((value): value is number => value !== null);
    const latestValue = values.length > 0 ? values[values.length - 1]! : null;
    const firstValue = values.length > 0 ? values[0]! : null;
    return {
      key,
      label: entry?.label ?? key,
      unit: entry?.unit ?? "",
      color: seriesColor(index),
      latestValue,
      deltaValue:
        latestValue !== null && firstValue !== null
          ? latestValue - firstValue
          : null,
      minValue:
        values.length > 0
          ? values.reduce((min, value) => Math.min(min, value), values[0]!)
          : null,
      maxValue:
        values.length > 0
          ? values.reduce((max, value) => Math.max(max, value), values[0]!)
          : null,
    };
  });
}

function summaryCardTone(source: "live-window" | "full-history"): string {
  return source === "full-history" ? "text-emerald-200" : "text-amber-200";
}

function compactStatusTone(source: "live-window" | "full-history"): string {
  return source === "full-history"
    ? "border-emerald-400/30 bg-emerald-500/8 text-emerald-200"
    : "border-amber-400/30 bg-amber-500/8 text-amber-200";
}

export default function ChartsViewport() {
  const cmd = useCommand();
  const tp = useTransport();
  const model = useModel();

  const [chartState, setChartState] = useChartPersistence();
  const [axisScale, setAxisScale] = useState<AxisScaleMode>("linear");
  const [showMarkers, setShowMarkers] = useState(false);

  const domains = useMemo(() => {
    const geometries = model.scriptBuilderGeometries ?? [];
    return geometries.map((geo) => ({
      id: geo.name,
      name: geo.name,
    }));
  }, [model.scriptBuilderGeometries]);

  const quantityGroups = useMemo(
    () => buildQuantityGroups(cmd.quantities),
    [cmd.quantities],
  );

  useEffect(() => {
    extendEntryMap(quantityGroups);
  }, [quantityGroups]);

  useEffect(() => {
    if (chartState.selectedDomain !== null) {
      setChartState((prev) => ({ ...prev, selectedDomain: null }));
    }
  }, [chartState.selectedDomain, setChartState]);

  const yColumns = useMemo(() => {
    if (chartState.activeSeriesKeys.length === 0) {
      return ["e_total"];
    }
    return chartState.activeSeriesKeys;
  }, [chartState.activeSeriesKeys]);

  const colors = useMemo(
    () => yColumns.map((_key, index) => seriesColor(index)),
    [yColumns],
  );

  const samplingSummary = useMemo(
    () => extractSamplingSummary(cmd.metadata),
    [cmd.metadata],
  );

  const sessionKey = cmd.session?.session_id ?? null;
  const scalarRowsTotal = tp.scalarRowsTotal ?? tp.scalarRows.length;
  const chartHistory = useScalarChartHistory({
    enabled: true,
    sessionKey,
    liveRows: tp.scalarRows,
    scalarRowsTotal,
  });

  const chartRows = chartHistory.deferredRows;
  const exportRows = chartHistory.rows;
  const latestRow = chartRows.length > 0 ? chartRows[chartRows.length - 1]! : null;
  const selectedSeriesCount = yColumns.length;
  const canDownloadCsv = exportRows.length > 0;

  const handleStateChange = useCallback(
    (next: ChartState | ((prev: ChartState) => ChartState)) => {
      setChartState(next);
    },
    [setChartState],
  );

  const handleDownloadCsv = useCallback(() => {
    if (!canDownloadCsv) {
      return;
    }
    const filename = `${sanitizeFilenameSegment(cmd.session?.problem_name)}_scalars.csv`;
    downloadTextFile(filename, serializeScalarRowsCsv(exportRows));
  }, [canDownloadCsv, cmd.session?.problem_name, exportRows]);

  const handleResetSelection = useCallback(() => {
    setChartState(DEFAULT_CHART_STATE);
    setAxisScale("linear");
    setShowMarkers(false);
  }, [setChartState]);

  const seriesStats = useMemo(
    () => statsForSeries(chartRows, yColumns),
    [chartRows, yColumns],
  );

  const canUseLogScale = useMemo(
    () =>
      seriesStats.length > 0 &&
      seriesStats.every((stat) => (stat.minValue ?? 0) > 0),
    [seriesStats],
  );
  const effectiveAxisScale: AxisScaleMode =
    axisScale === "log" && canUseLogScale ? "log" : "linear";

  const sourceLabel =
    chartHistory.source === "full-history" ? "Full history loaded" : "Live window";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border/30 bg-background/55 px-3 py-2 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
            <span className="mr-1 text-sm font-semibold tracking-[0.02em] text-foreground">
              Charts
            </span>
            <span className="rounded-full border border-border/35 bg-background/35 px-2 py-0.5 text-[0.68rem] text-muted-foreground">
              live `scalar_rows` {"->"} `scalars.csv`
            </span>
            <span className="rounded-full border border-border/35 bg-background/30 px-2 py-0.5 font-mono text-[0.68rem] text-foreground">
              {chartRows.length.toLocaleString()} / {scalarRowsTotal.toLocaleString()} samples
            </span>
            <span className="rounded-full border border-border/35 bg-background/30 px-2 py-0.5 font-mono text-[0.68rem] text-foreground">
              live {tp.scalarRows.length.toLocaleString()}
            </span>
            <span className="rounded-full border border-border/35 bg-background/30 px-2 py-0.5 font-mono text-[0.68rem] text-foreground">
              {samplingSummary.cadenceLabel}
            </span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-[0.68rem]",
                compactStatusTone(chartHistory.source),
              )}
            >
              {chartHistory.loading ? "loading history" : sourceLabel}
            </span>
            {chartHistory.error && (
              <span className="rounded-full border border-amber-400/35 bg-amber-500/10 px-2 py-0.5 text-[0.68rem] text-amber-200">
                history fetch failed
              </span>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 border-border/50 bg-background/35 px-2.5 text-[0.72rem]"
              onClick={handleResetSelection}
            >
              <RefreshCcw size={13} />
              Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 border-border/50 bg-background/35 px-2.5 text-[0.72rem]"
              onClick={handleDownloadCsv}
              disabled={!canDownloadCsv}
            >
              <Download size={13} />
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      <ChartQuantitySelector
        domains={domains}
        chartState={chartState}
        onStateChange={handleStateChange}
        quantityGroups={quantityGroups}
        supportsObjectScope={false}
      />

      <div className="grid flex-1 min-h-0 min-w-0 gap-2 p-2 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/45 bg-card/30 shadow-[0_10px_28px_rgba(0,0,0,0.14)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/35 bg-background/20 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full border border-border/40 bg-background/35 px-2 py-1 font-medium text-foreground">
                {selectedSeriesCount} series
              </span>
              <span className="rounded-full border border-border/40 bg-background/35 px-2 py-1 font-mono">
                persistence: scalars.csv
              </span>
              <span className={cn("rounded-full border px-2 py-1", summaryCardTone(chartHistory.source))}>
                {chartHistory.loading ? "Loading history…" : sourceLabel}
              </span>
              <span className="rounded-full border border-border/40 bg-background/35 px-2 py-1 font-mono">
                zarr only for fields
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5 border-border/50 bg-background/35 px-2.5 text-[0.72rem]",
                  showMarkers && "border-primary/50 bg-primary/12 text-primary",
                )}
                onClick={() => setShowMarkers((prev) => !prev)}
              >
                <CircleDot size={13} />
                Markers
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 gap-1.5 border-border/50 bg-background/35 px-2.5 text-[0.72rem]",
                  effectiveAxisScale === "log" && "border-primary/50 bg-primary/12 text-primary",
                )}
                disabled={!canUseLogScale}
                onClick={() =>
                  setAxisScale((prev) => (prev === "linear" ? "log" : "linear"))
                }
                title={
                  canUseLogScale
                    ? "Toggle log scale"
                    : "Log scale requires all selected values to stay above zero"
                }
              >
                <Activity size={13} />
                {effectiveAxisScale === "log" ? "Log Y" : "Linear Y"}
              </Button>
            </div>
          </div>

          <div className="relative flex-1 min-h-0 min-w-0">
            <ScalarPlot
              rows={chartRows}
              quantities={cmd.quantities}
              xColumn={chartState.xColumn}
              yColumns={yColumns}
              seriesColors={colors}
              yAxisScale={effectiveAxisScale}
              showMarkers={showMarkers}
              showRangeSlider
              alwaysShowModeBar
              uiRevisionKey={[
                chartState.xColumn,
                yColumns.join(","),
                effectiveAxisScale,
                showMarkers ? "markers:on" : "markers:off",
              ].join("|")}
            />
            {chartHistory.error && (
              <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[min(32rem,calc(100%-1.5rem))] rounded-lg border border-amber-400/30 bg-[#20130e]/90 px-3 py-2 text-[0.72rem] text-amber-100 shadow-lg backdrop-blur">
                Could not hydrate full history. Plot stays on the live window until
                `/v1/live/current/scalars` responds again.
              </div>
            )}
            {chartRows.length < 1 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
                <div className="rounded-xl border border-border/40 bg-background/88 px-4 py-3 text-center shadow-xl backdrop-blur">
                  <p className="text-sm font-medium text-foreground">
                    Waiting for scalar telemetry…
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The chart will populate from live `scalar_rows` and then
                    hydrate the full `scalars.csv` history when available.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/45 bg-card/25">
          <div className="border-b border-border/35 bg-background/15 px-3 py-2">
            <p className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
              Selection Inspector
            </p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
            <div className="rounded-lg border border-border/35 bg-background/20 px-3 py-2.5">
              <p className="text-[0.58rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/65">
                Current Tip
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-[0.62rem] uppercase tracking-[0.15em] text-muted-foreground/60">
                    Step
                  </p>
                  <p className="font-mono font-semibold text-foreground">
                    {latestRow?.step?.toLocaleString() ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[0.62rem] uppercase tracking-[0.15em] text-muted-foreground/60">
                    Time
                  </p>
                  <p className="font-mono font-semibold text-foreground">
                    {latestRow ? fmtTime(latestRow.time) : "—"}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/35 bg-background/20 px-3 py-2.5">
              <p className="text-[0.58rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/65">
                Data Plane
              </p>
              <div className="mt-2 space-y-1.5 text-[0.72rem] text-muted-foreground">
                <div className="flex items-center justify-between gap-2">
                  <span>Live source</span>
                  <span className="font-mono text-foreground">scalar_rows</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Disk trace</span>
                  <span className="font-mono text-foreground">scalars.csv</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Spatial store</span>
                  <span className="font-mono text-foreground">Zarr, not used here</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Scope</span>
                  <span className="font-mono text-foreground">Universe only</span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/35 bg-background/20 px-3 py-2.5">
              <p className="text-[0.58rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/65">
                Selected Series
              </p>
              <div className="mt-2 space-y-1.5">
                {seriesStats.map((stat) => (
                  <div
                    key={stat.key}
                    className="rounded-lg border border-border/35 bg-background/25 px-3 py-2"
                    style={{ borderLeftColor: stat.color, borderLeftWidth: 3 }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-[0.82rem] font-semibold text-foreground">
                          {stat.label}
                        </p>
                        <p className="text-[0.64rem] text-muted-foreground">
                          {stat.unit || "dimensionless"}
                        </p>
                      </div>
                      <p className="font-mono text-[0.78rem] font-semibold text-foreground">
                        {formatSeriesValue(stat.latestValue, stat.unit, stat.key)}
                      </p>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[0.68rem]">
                      <div>
                        <p className="uppercase tracking-[0.14em] text-muted-foreground/55">
                          Min
                        </p>
                        <p className="font-mono text-foreground">
                          {formatSeriesValue(stat.minValue, stat.unit, stat.key)}
                        </p>
                      </div>
                      <div>
                        <p className="uppercase tracking-[0.14em] text-muted-foreground/55">
                          Max
                        </p>
                        <p className="font-mono text-foreground">
                          {formatSeriesValue(stat.maxValue, stat.unit, stat.key)}
                        </p>
                      </div>
                      <div>
                        <p className="uppercase tracking-[0.14em] text-muted-foreground/55">
                          Δ loaded
                        </p>
                        <p
                          className={cn(
                            "font-mono",
                            (stat.deltaValue ?? 0) < 0
                              ? "text-emerald-300"
                              : "text-foreground",
                          )}
                        >
                          {formatSeriesDelta(stat.deltaValue, stat.unit, stat.key)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
                {seriesStats.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border/40 bg-background/20 px-3 py-3 text-center text-sm text-muted-foreground">
                    Choose a preset or add a series to inspect its live stats.
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
