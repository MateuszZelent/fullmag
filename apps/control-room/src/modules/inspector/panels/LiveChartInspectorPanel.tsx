"use client";

import { useContext } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import { useLiveChartPreferencesHydration } from "@/kernel/workspace/useLiveChartPreferencesHydration";
import { isLiveChartPresetId, liveChartPreset, type LiveChartPresetId } from "@/shared/analysis-charts/liveChartPresets";
import { resolveLiveChartSelectedSeriesIds } from "@/shared/analysis-charts/liveChartSelection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export function LiveChartInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref =
    selection.ref?.type === "live-chart" ||
    selection.ref?.type === "live-chart-point"
      ? selection.ref
      : null;
  const point = ref?.type === "live-chart-point" ? ref : null;
  const descriptorId = ref?.descriptorId ?? "magnetization";
  const presetId: LiveChartPresetId = isLiveChartPresetId(descriptorId) ? descriptorId : "custom";
  const preset = liveChartPreset(presetId);
  const preferences = useLiveChartPreferencesHydration(presetId);
  const descriptor = preferences.descriptor;
  const presetSeries = preset.defaultSeriesIds.map((id) => ({ id, quantity: id.split(":").at(-1) ?? id }));
  const seriesOptions = presetSeries.length > 0 ? presetSeries : (descriptor?.selectedSeriesIds ?? []).map((id) => ({ id, quantity: id.split(":").at(-1) ?? id }));
  const selectedSeriesIds = resolveLiveChartSelectedSeriesIds(
    descriptor?.selectedSeriesIds ?? preset.defaultSeriesIds,
    seriesOptions,
    preset.defaultSeriesIds,
  );

  const execute = (commandId: string, input: Record<string, unknown>) => {
    if (!kernel) return;
    void kernel.commands.execute(commandId, {
      layout: kernel.layout,
      selection: kernel.selection,
      source: "inspector",
      sourceDetail: "live-chart-inspector",
    }, input);
  };

  const setRange = (mode: string) => {
    const range: ChartRangePreference = mode === "tailRows"
      ? { mode: "tailRows", rows: 120 }
      : mode === "tailTime"
        ? { mode: "tailTime", durationS: 1e-9 }
        : mode === "fullDecimated"
          ? { mode: "fullDecimated" }
          : { mode: "follow" };
    execute("live-charts.set-range", { descriptorId: presetId, range });
  };

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Live Chart">
        <FieldRow label="Descriptor" value={ref?.descriptorId ?? "not available"} />
      </InspectorGroup>
      <InspectorGroup title="Display" description="Choose the live signals and window shown in the chart.">
        <div className="fm-inspector-field-row">
          <label className="fm-inspector-field-row__label" htmlFor="fm-live-chart-preset">Preset</label>
          <Select value={presetId} onValueChange={(value) => execute("live-charts.set-preset", { descriptorId: value })}>
            <SelectTrigger id="fm-live-chart-preset" aria-label="Live Chart preset" className="fm-live-chart-inspector__select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="magnetization">Magnetization</SelectItem>
              <SelectItem value="energy">Energy</SelectItem>
              <SelectItem value="convergence">Convergence</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="fm-inspector-field-row">
          <span className="fm-inspector-field-row__label">Live updates</span>
          <Switch
            aria-label="Follow live chart updates"
            checked={descriptor?.liveMode !== "paused"}
            onCheckedChange={(following) => execute("live-charts.set-live-mode", { descriptorId: presetId, liveMode: following ? "following" : "paused" })}
          />
        </div>
        <div className="fm-inspector-field-row">
          <label className="fm-inspector-field-row__label" htmlFor="fm-live-chart-range">Window</label>
          <Select value={descriptor?.range.mode ?? "follow"} onValueChange={setRange}>
            <SelectTrigger id="fm-live-chart-range" aria-label="Live Chart window" className="fm-live-chart-inspector__select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="follow">Follow tail</SelectItem>
              <SelectItem value="tailRows">Last 120 rows</SelectItem>
              <SelectItem value="tailTime">Last 1 ns</SelectItem>
              <SelectItem value="fullDecimated">Full, decimated</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {seriesOptions.length > 0 ? (
          <fieldset className="fm-live-chart-inspector__series">
            <legend className="fm-live-chart-inspector__legend">Signals</legend>
            {seriesOptions.map((series) => {
              const checked = selectedSeriesIds.includes(series.id);
              return (
                <label className="fm-live-chart-inspector__series-row" key={series.id}>
                  <input
                    aria-label={`Show ${series.quantity}`}
                    checked={checked}
                    className="fm-live-chart-inspector__checkbox"
                    type="checkbox"
                    onChange={(event) => {
                      const next = checked
                        ? selectedSeriesIds.filter((id) => id !== series.id)
                        : [...selectedSeriesIds, series.id];
                      execute("live-charts.set-selected-series", { descriptorId: presetId, selectedSeriesIds: next });
                      event.currentTarget.blur();
                    }}
                  />
                  <span>{series.quantity}</span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <p className="fm-live-chart-inspector__hint">Select signals from the chart legend.</p>
        )}
      </InspectorGroup>
      {point ? (
        <InspectorGroup title="Selected Point">
          <FieldRow label="Series" value={point.seriesId} />
          <FieldRow label="Point" value={String(point.pointIndex)} />
          <FieldRow label="Revision" value={String(point.revision)} />
        </InspectorGroup>
      ) : null}
    </div>
  );
}
