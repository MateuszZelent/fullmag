import type {
  AnalysisResultAxisResource,
  AnalysisResultAxisValueResource,
} from "@/kernel/api/apiTypes";

export interface AnalysisResultAxisPresentation {
  readonly canonicalUnit: string | null;
  readonly displayUnit: string;
  readonly displayUnits: readonly string[];
}

type ScalarUnitDefinition = {
  dimension: string;
  scaleToSI: number;
};

const SCALAR_UNITS: Readonly<Record<string, ScalarUnitDefinition>> = Object.freeze({
  "1": { dimension: "dimensionless", scaleToSI: 1 },
  Hz: { dimension: "frequency", scaleToSI: 1 },
  kHz: { dimension: "frequency", scaleToSI: 1e3 },
  MHz: { dimension: "frequency", scaleToSI: 1e6 },
  GHz: { dimension: "frequency", scaleToSI: 1e9 },
  s: { dimension: "time", scaleToSI: 1 },
  ms: { dimension: "time", scaleToSI: 1e-3 },
  us: { dimension: "time", scaleToSI: 1e-6 },
  "µs": { dimension: "time", scaleToSI: 1e-6 },
  ns: { dimension: "time", scaleToSI: 1e-9 },
  ps: { dimension: "time", scaleToSI: 1e-12 },
  m: { dimension: "length", scaleToSI: 1 },
  mm: { dimension: "length", scaleToSI: 1e-3 },
  um: { dimension: "length", scaleToSI: 1e-6 },
  "µm": { dimension: "length", scaleToSI: 1e-6 },
  nm: { dimension: "length", scaleToSI: 1e-9 },
  T: { dimension: "magnetic_induction", scaleToSI: 1 },
  mT: { dimension: "magnetic_induction", scaleToSI: 1e-3 },
  A: { dimension: "current", scaleToSI: 1 },
  mA: { dimension: "current", scaleToSI: 1e-3 },
  "A/m": { dimension: "field", scaleToSI: 1 },
  "kA/m": { dimension: "field", scaleToSI: 1e3 },
  "MA/m": { dimension: "field", scaleToSI: 1e6 },
  "rad/m": { dimension: "wavevector", scaleToSI: 1 },
  "rad/um": { dimension: "wavevector", scaleToSI: 1e6 },
});

function cleanUnit(value: string | null | undefined): string | null {
  const unit = value?.trim();
  return unit ? unit : null;
}

function uniqueUnits(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map(cleanUnit).filter((unit): unit is string => unit !== null))];
}

export function analysisResultAxisDisplayUnits(
  axis: Pick<AnalysisResultAxisResource, "preferred_display_units" | "projections" | "unit_si">,
): readonly string[] {
  return uniqueUnits([
    ...axis.preferred_display_units,
    axis.unit_si,
    ...axis.projections.map((projection) => projection.unit),
  ]);
}

export function analysisResultAxisPresentation(
  axis: Pick<AnalysisResultAxisResource, "preferred_display_units" | "projections" | "unit_si">,
  requestedUnit?: string | null,
): AnalysisResultAxisPresentation {
  const displayUnits = analysisResultAxisDisplayUnits(axis);
  const canonicalUnit = cleanUnit(axis.unit_si);
  const requested = cleanUnit(requestedUnit);
  return {
    canonicalUnit,
    displayUnit:
      requested && displayUnits.includes(requested)
        ? requested
        : displayUnits[0] ?? canonicalUnit ?? "1",
    displayUnits,
  };
}

function convertedScalarValue(
  value: number,
  fromUnit: string | null,
  toUnit: string,
): number | null {
  if (!Number.isFinite(value) || !fromUnit) return null;
  const from = SCALAR_UNITS[fromUnit];
  const to = SCALAR_UNITS[toUnit];
  if (!from || !to || from.dimension !== to.dimension) return null;
  return (value * from.scaleToSI) / to.scaleToSI;
}

function formatScalar(value: number, unit: string): string {
  const absolute = Math.abs(value);
  const digits = absolute !== 0 && (absolute >= 1e4 || absolute < 1e-3) ? 5 : 6;
  return `${value.toPrecision(digits)} ${unit}`;
}

export function formatAnalysisResultAxisValue(
  axis: Pick<AnalysisResultAxisResource, "preferred_display_units" | "projections" | "unit_si">,
  value: AnalysisResultAxisValueResource,
  requestedUnit?: string | null,
): string {
  const presentation = analysisResultAxisPresentation(axis, requestedUnit);
  if (value.scalar_si != null) {
    const converted = convertedScalarValue(
      value.scalar_si,
      presentation.canonicalUnit,
      presentation.displayUnit,
    );
    if (converted != null) return formatScalar(converted, presentation.displayUnit);
  }
  return value.label?.trim() || value.token;
}
