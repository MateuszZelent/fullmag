"use client";

import {
  DISPERSION_AXIS_LABELS,
  type DispersionAxis,
} from "@/shared/domain/analysis/dispersionChartAxes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

export function DispersionAxisControls({
  axis,
  axes,
  onAxisChange,
}: {
  axis: DispersionAxis;
  axes: readonly DispersionAxis[];
  onAxisChange: (axis: DispersionAxis) => void;
}) {
  const hasSignedComponents = axes.some((value) => value !== "path");
  return (
    <div className="fm-dispersion-axis-controls" data-dispersion-axis={axis}>
      <span className="fm-dispersion-axis-controls__label">Horizontal coordinate</span>
      <Select
        value={axis}
        onValueChange={(value) => {
          if (axes.includes(value as DispersionAxis)) onAxisChange(value as DispersionAxis);
        }}
      >
        <SelectTrigger aria-label="Dispersion wavevector coordinate" density="compact">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {axes.map((value) => (
            <SelectItem key={value} value={value}>
              {DISPERSION_AXIS_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="fm-dispersion-axis-controls__hint" role="status">
        {hasSignedComponents
          ? "Signed k uses each published vector · rad/m"
          : "Signed k components unavailable: one or more points lack a published k vector"}
      </span>
    </div>
  );
}
