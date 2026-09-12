"use client";

import { Download, Maximize2, Pause, Play } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import type { LiveChartPresetId } from "../liveChartsModel";
import type { LiveChartsViewProps } from "../liveChartsViewTypes";

export function LiveChartControls({ descriptorId, isFollowing, onDescriptorChange, onExport, onFit, onToggleFollow, xAxisId, xAxisOptions = [], onXAxisChange, range, onRangeChange, series, selectedSeriesIds }: LiveChartsViewProps) {
  const selected = new Set(selectedSeriesIds);
  const hasVisibleSamples = series.some((item) => selected.has(item.id) && item.points.length > 0);
  const rangeValue = range?.mode ?? "follow";
  return <div className="fm-live-charts__controls">
    <div className="fm-live-charts__selectors">
      <label className="fm-live-charts__control-field">
        <span>View</span>
        <Select value={descriptorId} onValueChange={(value) => onDescriptorChange(value as LiveChartPresetId)}>
          <SelectTrigger aria-label="Chart preset" className="fm-live-charts__preset"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="magnetization">Magnetization</SelectItem>
            <SelectItem value="energy">Energy</SelectItem>
            <SelectItem value="convergence">Convergence</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {xAxisOptions.length > 0 ? <label className="fm-live-charts__control-field">
        <span>Horizontal axis</span>
        <Select value={xAxisId} disabled={!onXAxisChange || xAxisOptions.length < 2} onValueChange={onXAxisChange}>
          <SelectTrigger aria-label="Horizontal axis"><SelectValue /></SelectTrigger>
          <SelectContent>{xAxisOptions.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </label> : null}
      {onRangeChange ? <label className="fm-live-charts__control-field">
        <span>Window</span>
        <Select value={rangeValue} onValueChange={(value) => onRangeChange(value === "fullDecimated" ? { mode: "fullDecimated" } : { mode: "follow" })}>
          <SelectTrigger aria-label="Sample window"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="follow">Latest samples</SelectItem>
            <SelectItem value="fullDecimated">Full history</SelectItem>
            {rangeValue === "fixed" ? <SelectItem value="fixed" disabled>Selected range</SelectItem> : null}
            {rangeValue === "tailTime" || rangeValue === "tailRows" ? <SelectItem value={rangeValue} disabled>Custom window</SelectItem> : null}
          </SelectContent>
        </Select>
      </label> : null}
    </div>
    <div className="fm-live-charts__actions">
      <Button aria-label={isFollowing ? "Pause" : "Follow"} title={isFollowing ? "Pause chart updates; the simulation continues" : "Resume chart updates"} onClick={onToggleFollow} className="fm-live-charts__follow" variant={isFollowing ? "primary" : "secondary"} size="md">
        {isFollowing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{isFollowing ? "Pause" : "Follow"}
      </Button>
      <Button aria-label="Fit" title="Fit the visible samples" disabled={!hasVisibleSamples} onClick={onFit} size="md"><Maximize2 size={14} aria-hidden="true" /> Fit</Button>
      <Button aria-label="Export CSV" title="Export visible sampled signals as CSV" disabled={!hasVisibleSamples} onClick={() => onExport("csv")} size="md"><Download size={14} aria-hidden="true" /> CSV</Button>
    </div>
  </div>;
}
