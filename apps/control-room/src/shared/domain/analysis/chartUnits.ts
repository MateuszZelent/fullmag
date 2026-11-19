export type ChartDimension =
  | "arbitrary"
  | "dimensionless"
  | "energy"
  | "energy_density"
  | "field"
  | "frequency"
  | "phase"
  | "time"
  | "wavevector";

export interface ChartUnit {
  canonicalUnit: string;
  dimension: ChartDimension;
  scaleToCanonical: number;
  unit: string;
}

const UNIT_DEFINITIONS: Readonly<Record<string, Omit<ChartUnit, "unit">>> =
  Object.freeze({
    "": {
      canonicalUnit: "1",
      dimension: "dimensionless",
      scaleToCanonical: 1,
    },
    "1": {
      canonicalUnit: "1",
      dimension: "dimensionless",
      scaleToCanonical: 1,
    },
    "a.u.": {
      canonicalUnit: "a.u.",
      dimension: "arbitrary",
      scaleToCanonical: 1,
    },
    "rad": {
      canonicalUnit: "rad",
      dimension: "phase",
      scaleToCanonical: 1,
    },
    "s": { canonicalUnit: "s", dimension: "time", scaleToCanonical: 1 },
    "ms": { canonicalUnit: "s", dimension: "time", scaleToCanonical: 1e-3 },
    "us": { canonicalUnit: "s", dimension: "time", scaleToCanonical: 1e-6 },
    "µs": { canonicalUnit: "s", dimension: "time", scaleToCanonical: 1e-6 },
    "ns": { canonicalUnit: "s", dimension: "time", scaleToCanonical: 1e-9 },
    "ps": { canonicalUnit: "s", dimension: "time", scaleToCanonical: 1e-12 },
    "Hz": {
      canonicalUnit: "Hz",
      dimension: "frequency",
      scaleToCanonical: 1,
    },
    "kHz": {
      canonicalUnit: "Hz",
      dimension: "frequency",
      scaleToCanonical: 1e3,
    },
    "MHz": {
      canonicalUnit: "Hz",
      dimension: "frequency",
      scaleToCanonical: 1e6,
    },
    "GHz": {
      canonicalUnit: "Hz",
      dimension: "frequency",
      scaleToCanonical: 1e9,
    },
    "pJ": { canonicalUnit: "J", dimension: "energy", scaleToCanonical: 1e-12 },
    "nJ": { canonicalUnit: "J", dimension: "energy", scaleToCanonical: 1e-9 },
    "µJ": { canonicalUnit: "J", dimension: "energy", scaleToCanonical: 1e-6 },
    "mJ": { canonicalUnit: "J", dimension: "energy", scaleToCanonical: 1e-3 },
    "J": { canonicalUnit: "J", dimension: "energy", scaleToCanonical: 1 },
    "kJ": { canonicalUnit: "J", dimension: "energy", scaleToCanonical: 1e3 },
    "J/m3": {
      canonicalUnit: "J/m3",
      dimension: "energy_density",
      scaleToCanonical: 1,
    },
    "J/m³": {
      canonicalUnit: "J/m3",
      dimension: "energy_density",
      scaleToCanonical: 1,
    },
    "mA/m": { canonicalUnit: "A/m", dimension: "field", scaleToCanonical: 1e-3 },
    "A/m": {
      canonicalUnit: "A/m",
      dimension: "field",
      scaleToCanonical: 1,
    },
    "kA/m": { canonicalUnit: "A/m", dimension: "field", scaleToCanonical: 1e3 },
    "MA/m": { canonicalUnit: "A/m", dimension: "field", scaleToCanonical: 1e6 },
    "rad/m": {
      canonicalUnit: "rad/m",
      dimension: "wavevector",
      scaleToCanonical: 1,
    },
  });

export function resolveChartUnit(unit: string): ChartUnit | null {
  const definition = UNIT_DEFINITIONS[unit.trim()];
  return definition ? { ...definition, unit: unit.trim() } : null;
}

export function chartUnitsCompatible(left: string, right: string): boolean {
  const leftUnit = resolveChartUnit(left);
  const rightUnit = resolveChartUnit(right);
  if (!leftUnit || !rightUnit) return left.trim() === right.trim();
  return (
    leftUnit.dimension === rightUnit.dimension &&
    leftUnit.canonicalUnit === rightUnit.canonicalUnit
  );
}

/** Available display units within the same physical dimension for chart controls. */
export function chartDisplayUnitOptions(unit: string): string[] {
  const resolved = resolveChartUnit(unit);
  if (!resolved) return [unit.trim()];
  const compatible = Object.keys(UNIT_DEFINITIONS)
    .filter((candidate) => candidate !== "" && chartUnitsCompatible(unit, candidate));
  return [...new Set(compatible.length > 0 ? compatible : [unit.trim()])];
}

export function convertChartUnitValue(
  value: number,
  fromUnit: string,
  toUnit: string,
): number {
  if (!Number.isFinite(value)) return value;
  if (!chartUnitsCompatible(fromUnit, toUnit)) {
    throw new Error(
      `Incompatible chart units: ${fromUnit || "(empty)"} and ${toUnit || "(empty)"}.`,
    );
  }
  const from = resolveChartUnit(fromUnit);
  const to = resolveChartUnit(toUnit);
  if (!from || !to) return value;
  return (value * from.scaleToCanonical) / to.scaleToCanonical;
}
