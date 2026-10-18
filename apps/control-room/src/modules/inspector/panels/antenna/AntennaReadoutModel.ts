import type { ReactNode } from "react";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";

export interface AntennaReadoutRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
  unit?: string;
  section?: "runtime";
}

/** Display conversion only; authoring and runtime resources retain SI values. */
export function formatAntennaParameter(value: unknown, unit = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return `unavailable${unit ? ` ${unit}` : ""}`;
  if (unit === "Hz") return formatFrequencyHz(value);
  const magnitude = Math.abs(value);
  if (unit === "A" && magnitude >= 1e-3 && magnitude < 1) return formatValueWithUnit(value * 1e3, "mA");
  if (unit === "S/m" && magnitude >= 1e6) return formatValueWithUnit(value * 1e-6, "MS/m");
  if (unit === "s" && magnitude > 0 && magnitude < 1) {
    if (magnitude >= 1e-3) return formatValueWithUnit(value * 1e3, "ms");
    if (magnitude >= 1e-6) return formatValueWithUnit(value * 1e6, "µs");
    if (magnitude >= 1e-9) return formatValueWithUnit(value * 1e9, "ns");
    if (magnitude >= 1e-12) return formatValueWithUnit(value * 1e12, "ps");
  }
  return formatValueWithUnit(value, unit);
}

export function partitionAntennaReadout(rows: readonly AntennaReadoutRow[]) {
  return {
    parameters: rows.filter(row => !row.mono && row.section !== "runtime"),
    runtime: rows.filter(row => !row.mono && row.section === "runtime"),
    identity: rows.filter(row => row.mono),
  };
}
