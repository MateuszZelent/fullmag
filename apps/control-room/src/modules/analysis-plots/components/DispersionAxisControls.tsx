"use client";

import type { DispersionAxis } from "@/shared/domain/analysis/dispersionChartAxes";
import { DISPERSION_AXIS_LABELS } from "@/shared/domain/analysis/dispersionChartAxes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

export function DispersionAxisControls({ axis, axes, unit, onAxisChange, onUnitChange }: {
  axis: DispersionAxis; axes: readonly DispersionAxis[]; unit: string;
  onAxisChange: (axis: DispersionAxis) => void; onUnitChange: (unit: string) => void;
}) {
  return <div className="fm-dispersion-controls" data-dispersion-axis={axis}>
    <div className="fm-dispersion-controls__selectors">
      <div className="fm-dispersion-controls__field">
        <span>Wavevector coordinate</span>
        <Select value={axis} onValueChange={(value) => onAxisChange(value as DispersionAxis)}>
          <SelectTrigger aria-label="Dispersion wavevector coordinate"><SelectValue /></SelectTrigger>
          <SelectContent>{axes.map((value) => <SelectItem key={value} value={value}>{DISPERSION_AXIS_LABELS[value]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="fm-dispersion-controls__field">
        <span>Wavevector unit</span>
        <Select value={unit} onValueChange={onUnitChange}>
          <SelectTrigger aria-label="Dispersion wavevector unit"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="rad/µm">rad/µm</SelectItem><SelectItem value="rad/m">rad/m</SelectItem></SelectContent>
        </Select>
      </div>
    </div>
    <p className="fm-dispersion-controls__hint">{axes.length === 1
      ? "Signed components require a published k vector for every point. Showing the recorded path coordinate."
      : "Signed components use the published k vector. Path distance follows sampling order. Select a point to inspect its mode."}</p>
  </div>;
}
