"use client";

import { Button } from "@/shared/ui/Button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import type { LiveChartPresetId } from "../liveChartsModel";

export function LiveChartControls({ descriptorId, following, onDescriptorChange, onExport, onFit, onToggleFollow }: {
  descriptorId: LiveChartPresetId;
  following: boolean;
  onDescriptorChange: (id: LiveChartPresetId) => void;
  onExport: (format: "csv" | "tsv" | "png") => void;
  onFit: () => void;
  onToggleFollow: () => void;
}) {
  return <div className="fm-live-charts__controls">
    <Select value={descriptorId} onValueChange={(value) => onDescriptorChange(value as LiveChartPresetId)}>
      <SelectTrigger aria-label="Chart preset" className="fm-live-charts__preset"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="magnetization">Magnetization</SelectItem><SelectItem value="energy">Energy</SelectItem><SelectItem value="convergence">Convergence</SelectItem><SelectItem value="custom">Custom</SelectItem>
      </SelectContent>
    </Select>
    <Button aria-label={following ? "Pause" : "Follow"} onClick={onToggleFollow} size="sm">{following ? "Pause" : "Follow"}</Button>
    <Button aria-label="Fit" onClick={onFit} size="sm">Fit</Button>
    <Button aria-label="Export CSV" onClick={() => onExport("csv")} size="sm">CSV</Button>
  </div>;
}
