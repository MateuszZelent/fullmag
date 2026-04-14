"use client";

/**
 * ChartsViewport — full-featured charting workbench for the dock center.
 *
 * Replaces the old hardcoded 4-column chart with:
 *  - premium ChartQuantitySelector header (domain, presets, X/Y controls)
 *  - Plotly ScalarPlot chart body
 *  - localStorage persistence for chart configuration
 *  - Dynamic quantity groups from backend QuantityDescriptor[]
 */

import { useMemo, useCallback, useEffect } from "react";

import ScalarPlot from "@/components/plots/ScalarPlot";
import ChartQuantitySelector from "@/components/plots/ChartQuantitySelector";
import { extractSamplingSummary } from "@/components/plots/chartSampling";
import { useCommand, useModel, useTransport } from "./ControlRoomContext";
import { useChartPersistence } from "@/hooks/useChartPersistence";
import {
  type ChartState,
  seriesColor,
  buildQuantityGroups,
  extendEntryMap,
} from "@/components/plots/chartTypes";

export default function ChartsViewport() {
  const cmd = useCommand();
  const tp = useTransport();
  const model = useModel();

  const [chartState, setChartState] = useChartPersistence();

  // Build domain list from model geometries
  const domains = useMemo(() => {
    const geometries = model.scriptBuilderGeometries ?? [];
    return geometries.map((geo) => ({
      id: geo.name,
      name: geo.name,
    }));
  }, [model.scriptBuilderGeometries]);

  // Build quantity groups from runtime descriptors, falling back to catalog
  const quantityGroups = useMemo(
    () => buildQuantityGroups(cmd.quantities),
    [cmd.quantities],
  );

  // Keep the entry map in sync with dynamically-resolved groups
  useEffect(() => {
    extendEntryMap(quantityGroups);
  }, [quantityGroups]);

  // Compute effective y-columns from chart state
  const yColumns = useMemo(() => {
    if (chartState.activeSeriesKeys.length === 0) {
      return ["e_total"];
    }
    return chartState.activeSeriesKeys;
  }, [chartState.activeSeriesKeys]);

  // Build colors aligned with yColumns
  const colors = useMemo(() => {
    return yColumns.map((_key, i) => seriesColor(i));
  }, [yColumns]);
  const rowCount = tp.scalarRows.length;
  const selectedSeriesCount = chartState.activeSeriesKeys.length;
  const renderedSeriesCount = yColumns.length;

  // Sampling cadence from execution plan metadata
  const samplingSummary = useMemo(
    () => extractSamplingSummary(cmd.metadata),
    [cmd.metadata],
  );

  // Handler for state changes
  const handleStateChange = useCallback(
    (next: ChartState | ((prev: ChartState) => ChartState)) => {
      setChartState(next);
    },
    [setChartState],
  );

  // ── Always render chart — ScalarPlot handles empty rows gracefully ──

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <ChartQuantitySelector
        domains={domains}
        chartState={chartState}
        onStateChange={handleStateChange}
        quantityGroups={quantityGroups}
      />
      <div className="grid grid-cols-1 gap-2 border-b border-border/40 bg-card/25 px-3 py-2.5 text-[0.72rem] md:grid-cols-3">
        <div className="rounded-md border border-border/40 bg-background/30 px-2.5 py-1.5">
          <p className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
            Sampling cadence
          </p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
            {samplingSummary.cadenceLabel}
          </p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/30 px-2.5 py-1.5">
          <p className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
            Active series
          </p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
            {selectedSeriesCount}
            <span className="text-xs font-normal text-muted-foreground/70">
              {" "}
              selected / {renderedSeriesCount} rendered
            </span>
          </p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/30 px-2.5 py-1.5">
          <p className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
            Telemetry rows (RAM)
          </p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
            {rowCount.toLocaleString()}
          </p>
        </div>
      </div>
      <div className="relative flex-1 min-h-0 min-w-0">
        <ScalarPlot
          rows={tp.scalarRows}
          quantities={cmd.quantities}
          xColumn={chartState.xColumn}
          yColumns={yColumns}
          seriesColors={colors}
          uiRevisionKey={`x:${chartState.xColumn}|y:${yColumns.join(",")}`}
        />
        {/* Subtle overlay when no data yet */}
        {rowCount < 1 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg border border-border/30 bg-background/80 backdrop-blur-sm px-5 py-3 shadow-lg">
              <p className="text-sm font-medium text-muted-foreground">
                Waiting for solver telemetry…
              </p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Chart will populate as scalar samples arrive.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
