"use client";

/**
 * @module features/plots2d/components/Plot2DToolbar
 *
 * Compact toolbar for the 2D Plots Workbench.
 * Provides: preset pills, series add/remove, x-axis switch, y-scale, export.
 *
 * All actions dispatch through `usePlot2DStore` — single source of truth.
 * The View ribbon mirrors the same store (§12.4 of masterplan).
 */

import { usePlot2DStore, selectUI, selectAvailableSeries } from "../store/usePlot2DStore";
import { getPresetsInOrder } from "../model/plotPresets";
import { serializeScalarTableCsv } from "../model/scalarTable";
import { groupSeriesMeta } from "../model/scalarSeriesMeta";
import type { ScalarSeriesMeta } from "../model/plot2dTypes";

export function Plot2DToolbar() {
  const ui = usePlot2DStore(selectUI);
  const availableSeries = usePlot2DStore(selectAvailableSeries);
  const store = usePlot2DStore;

  const presets = getPresetsInOrder();
  const groups = groupSeriesMeta(
    availableSeries.length > 0
      ? availableSeries
      : [],
  );

  const handleExportCsv = () => {
    const table = usePlot2DStore.getState().scalar.table;
    if (!table || table.rowCount === 0) return;
    const csv = serializeScalarTableCsv(table, {
      columns: ["step", "time", ...ui.activeSeriesKeys],
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scalar_data_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex items-center gap-1.5 border-b border-border/10 bg-card/40 px-3 py-1.5">
      {/* Preset pills */}
      <div className="flex items-center gap-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            onClick={() => store.getState().applyPreset(preset.id)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              ui.activePresetId === preset.id
                ? "bg-accent/20 text-accent"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
            title={preset.description}
          >
            {preset.icon && <span className="mr-1">{preset.icon}</span>}
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mx-1 h-4 w-px bg-border/20" />

      {/* Series selector (dropdown-style) */}
      <div className="relative group">
        <button className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground">
          + Series
        </button>
        <div className="absolute left-0 top-full z-50 hidden min-w-[200px] rounded-lg border border-border/20 bg-card/95 p-2 shadow-xl backdrop-blur-sm group-hover:block">
          {groups.map((group) => (
            <div key={group.group} className="mb-2 last:mb-0">
              <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.label}
              </div>
              {group.items.map((item: ScalarSeriesMeta) => {
                const active = ui.activeSeriesKeys.includes(item.key);
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      if (active) {
                        store.getState().removeSeries(item.key);
                      } else {
                        store.getState().addSeries(item.key);
                      }
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-0.5 text-[11px] transition-colors ${
                      active
                        ? "bg-accent/10 text-accent"
                        : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${active ? "bg-accent" : "bg-muted/40"}`} />
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.unit && (
                      <span className="text-[9px] text-muted-foreground/50">{item.unit}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1" />

      {/* X-axis toggle */}
      <div className="flex items-center gap-0.5 rounded bg-muted/20 p-0.5">
        {(["time", "step"] as const).map((col) => (
          <button
            key={col}
            onClick={() => store.getState().setXColumn(col)}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              ui.xColumn === col
                ? "bg-accent/20 text-accent"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {col === "time" ? "Time" : "Step"}
          </button>
        ))}
      </div>

      {/* Y-scale toggle */}
      <button
        onClick={() => store.getState().setYScale(ui.yScale === "linear" ? "log" : "linear")}
        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
          ui.yScale === "log"
            ? "bg-amber-500/15 text-amber-400"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title={ui.yScale === "log" ? "Switch to linear scale" : "Switch to log scale"}
      >
        {ui.yScale === "log" ? "LOG" : "LIN"}
      </button>

      {/* Markers toggle */}
      <button
        onClick={() => store.getState().toggleMarkers()}
        className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
          ui.showMarkers
            ? "bg-accent/15 text-accent"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Toggle markers"
      >
        ◆
      </button>

      {/* Range slider toggle */}
      <button
        onClick={() => store.getState().toggleRangeSlider()}
        className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
          ui.showRangeSlider
            ? "bg-accent/15 text-accent"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Toggle range slider"
      >
        ⇔
      </button>

      <div className="mx-1 h-4 w-px bg-border/20" />

      {/* Export CSV */}
      <button
        onClick={handleExportCsv}
        className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        title="Export CSV"
      >
        CSV
      </button>
    </div>
  );
}

export default Plot2DToolbar;
