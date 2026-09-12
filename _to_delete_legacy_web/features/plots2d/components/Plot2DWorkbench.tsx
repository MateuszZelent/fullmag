"use client";

/**
 * @module features/plots2d/components/Plot2DWorkbench
 *
 * Main container component for the 2D Plots tab.
 *
 * Replaces the old `ChartsViewport` god component with a clean
 * composition of toolbar, chart, inspector, and status bar.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────┐
 * │ [Plot2DToolbar — presets, series, x-axis, export]   │
 * ├──────────────────────────────────┬──────────────────┤
 * │                                  │  SeriesInspector  │
 * │   ScalarTimeSeriesECharts        │  (stats sidebar)  │
 * │   (main chart area)              │                   │
 * ├──────────────────────────────────┴──────────────────┤
 * │ [Plot2DStatusBar: samples, cadence, source, plane]  │
 * └─────────────────────────────────────────────────────┘
 */

import { useMemo } from "react";
import { usePlot2DStore, selectUI, selectScalarTable, selectRowsFingerprint, selectScalarSource, selectScalarLoading, selectScalarError, selectScalarTotalRows } from "../store/usePlot2DStore";
import { ScalarTimeSeriesECharts } from "./ScalarTimeSeriesECharts";
import { Plot2DToolbar } from "./Plot2DToolbar";
import { Plot2DStatusBar } from "./Plot2DStatusBar";
import { SeriesInspector } from "./SeriesInspector";

export function Plot2DWorkbench() {
  const ui = usePlot2DStore(selectUI);
  const table = usePlot2DStore(selectScalarTable);
  const fingerprint = usePlot2DStore(selectRowsFingerprint);
  const source = usePlot2DStore(selectScalarSource);
  const loading = usePlot2DStore(selectScalarLoading);
  const error = usePlot2DStore(selectScalarError);
  const totalRows = usePlot2DStore(selectScalarTotalRows);

  const optionFingerprint = useMemo(
    () => `${fingerprint}:${ui.activeSeriesKeys.join(",")}:${ui.xColumn}:${ui.yScale}:${ui.showMarkers}:${ui.showRangeSlider}`,
    [fingerprint, ui.activeSeriesKeys, ui.xColumn, ui.yScale, ui.showMarkers, ui.showRangeSlider],
  );

  const showInspector = ui.activeSeriesKeys.length > 0 && table && table.rowCount > 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* ── Toolbar ── */}
      <Plot2DToolbar />

      {/* ── Main content ── */}
      <div className="flex min-h-0 flex-1">
        {/* Chart area */}
        <div className="relative min-w-0 flex-1">
          {error ? (
            <div className="flex h-full items-center justify-center">
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-6 py-4 text-sm text-destructive">
                {error}
              </div>
            </div>
          ) : loading && !table ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-sm text-muted-foreground">Loading scalar data…</div>
            </div>
          ) : !table || table.rowCount === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <div className="text-sm font-medium text-muted-foreground">No data available</div>
              <div className="text-xs text-muted-foreground/60">
                Start a simulation to see scalar time-series
              </div>
            </div>
          ) : (
            <ScalarTimeSeriesECharts
              table={table}
              seriesKeys={ui.activeSeriesKeys}
              xColumn={ui.xColumn}
              yScale={ui.yScale}
              showMarkers={ui.showMarkers}
              showRangeSlider={ui.showRangeSlider}
              optionFingerprint={optionFingerprint}
            />
          )}
        </div>

        {/* Series inspector sidebar */}
        {showInspector && (
          <div className="w-52 shrink-0 border-l border-border/10 overflow-y-auto">
            <SeriesInspector
              table={table}
              seriesKeys={ui.activeSeriesKeys}
            />
          </div>
        )}
      </div>

      {/* ── Status bar ── */}
      <Plot2DStatusBar
        source={source}
        rowCount={table?.rowCount ?? 0}
        totalRows={totalRows}
        loading={loading}
        plane={ui.mode === "spatial-slice" ? ui.plane : undefined}
      />
    </div>
  );
}

export default Plot2DWorkbench;
