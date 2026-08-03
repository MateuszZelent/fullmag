"use client";

import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { chartDisplayUnitOptions } from "@/shared/domain/analysis/chartUnits";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

export function ChartDisplayUnitControls({
  displayUnits,
  onDisplayUnitsChange,
  series,
}: {
  displayUnits: Readonly<Record<string, string>>;
  onDisplayUnitsChange: (patch: Record<string, string>) => void;
  series: readonly ChartSeries[];
}) {
  const groupsByUnit = new Map<string, ChartSeries[]>();
  for (const item of series) {
    const items = groupsByUnit.get(item.unit) ?? [];
    items.push(item);
    groupsByUnit.set(item.unit, items);
  }
  const groups = [...groupsByUnit.entries()]
    .map(([unit, items]) => ({ items, options: chartDisplayUnitOptions(unit), unit }))
    .filter((group) => group.options.length > 1);
  if (groups.length === 0) return null;
  return <div className="fm-chart-display-units" aria-label="Display units">
    {groups.map((group) => {
      const requested = group.items.map((item) => displayUnits[item.quantity]).filter((unit): unit is string => Boolean(unit));
      const selected = requested.length > 0 && requested.every((unit) => unit === requested[0]) && group.options.includes(requested[0]!)
        ? requested[0]!
        : group.unit;
      const label = group.items.map((item) => item.label || item.quantity).join(", ");
      return <Select key={group.unit} value={selected} onValueChange={(unit) => onDisplayUnitsChange(Object.fromEntries(group.items.map((item) => [item.quantity, unit])))}>
        <SelectTrigger aria-label={`Display unit for ${label}`}><SelectValue /></SelectTrigger>
        <SelectContent>{group.options.map((unit) => <SelectItem key={unit || "dimensionless"} value={unit}>{unit || "dimensionless"}</SelectItem>)}</SelectContent>
      </Select>;
    })}
  </div>;
}
