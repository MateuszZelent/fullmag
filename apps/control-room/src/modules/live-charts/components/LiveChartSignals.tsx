"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { ChartLegend } from "@/shared/analysis-charts/ChartLegend";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { liveChartReadings } from "../liveChartsPresentation";

export function LiveChartSignals({ series, selectedSeriesIds, onSeriesChange }: {
  series: readonly ChartSeries[];
  selectedSeriesIds: readonly string[];
  onSeriesChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const readings = useMemo(() => liveChartReadings(series), [series]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = readings.filter((item) => `${item.label} ${item.unit} ${item.id}`.toLocaleLowerCase().includes(query));
  const selected = new Set(selectedSeriesIds);
  const selectedCount = readings.filter((item) => selected.has(item.id)).length;
  return (
    <aside className="fm-live-charts__signals" aria-label="Signal selection">
      <div className="fm-live-charts__signals-heading">
        <h3><SlidersHorizontal size={14} aria-hidden="true" /> Signals</h3>
        <span>{selectedCount} / {readings.length}</span>
      </div>
      <div className="fm-live-charts__search">
        <Search size={14} aria-hidden="true" />
        <Input aria-label="Search signals" placeholder="Find a signal…" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="fm-live-charts__signal-actions">
        <span>Latest sample</span>
        <Button size="sm" variant="ghost" disabled={readings.length === 0 || selectedCount === readings.length} onClick={() => onSeriesChange(readings.map((item) => item.id))}>All</Button>
        <Button size="sm" variant="ghost" disabled={selectedCount === 0} onClick={() => onSeriesChange([])}>None</Button>
      </div>
      <div className="fm-live-charts__signal-list">
        <ChartLegend items={filtered} availableSeriesIds={readings.map((item) => item.id)} selectedSeriesIds={selectedSeriesIds} onSelectedSeriesIdsChange={onSeriesChange} />
        {filtered.length === 0 ? <p className="fm-live-charts__signal-message" role="status">{readings.length ? "No matching signals" : "Signals appear when samples arrive."}</p> : null}
      </div>
      <p className="fm-live-charts__signal-hint">Click to show or hide.<br /><kbd>Shift</kbd> + click to isolate a signal.</p>
    </aside>
  );
}
