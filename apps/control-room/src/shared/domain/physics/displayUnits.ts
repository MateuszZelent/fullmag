export interface DisplayUnitItem {
  label: string;
  value: string;
}

interface DisplayUnitDefinition {
  factor: number;
  label: string;
  value: string;
}

const MU0_T_PER_APM = 4 * Math.PI * 1e-7;

const DISPLAY_UNITS_BY_SOURCE_UNIT: Record<string, DisplayUnitDefinition[]> = {
  "A/m": [
    { value: "A/m", label: "A/m", factor: 1 },
    { value: "kA/m", label: "kA/m", factor: 1e-3 },
    { value: "MA/m", label: "MA/m", factor: 1e-6 },
    { value: "T", label: "T", factor: MU0_T_PER_APM },
    { value: "mT", label: "mT", factor: MU0_T_PER_APM * 1e3 },
  ],
  T: [
    { value: "T", label: "T", factor: 1 },
    { value: "mT", label: "mT", factor: 1e3 },
    { value: "A/m", label: "A/m", factor: 1 / MU0_T_PER_APM },
    { value: "kA/m", label: "kA/m", factor: 1e-3 / MU0_T_PER_APM },
    { value: "MA/m", label: "MA/m", factor: 1e-6 / MU0_T_PER_APM },
  ],
  J: [
    { value: "J", label: "J", factor: 1 },
    { value: "mJ", label: "mJ", factor: 1e3 },
    { value: "uJ", label: "uJ", factor: 1e6 },
    { value: "nJ", label: "nJ", factor: 1e9 },
  ],
  "J/m": [
    { value: "J/m", label: "J/m", factor: 1 },
    { value: "mJ/m", label: "mJ/m", factor: 1e3 },
    { value: "uJ/m", label: "uJ/m", factor: 1e6 },
    { value: "nJ/m", label: "nJ/m", factor: 1e9 },
    { value: "pJ/m", label: "pJ/m", factor: 1e12 },
  ],
  "J/m²": [
    { value: "J/m²", label: "J/m²", factor: 1 },
    { value: "mJ/m²", label: "mJ/m²", factor: 1e3 },
    { value: "uJ/m²", label: "uJ/m²", factor: 1e6 },
  ],
  "J/m³": [
    { value: "J/m³", label: "J/m³", factor: 1 },
    { value: "kJ/m³", label: "kJ/m³", factor: 1e-3 },
    { value: "MJ/m³", label: "MJ/m³", factor: 1e-6 },
  ],
  "1/s": [
    { value: "1/s", label: "1/s", factor: 1 },
    { value: "kHz", label: "kHz", factor: 1e-3 },
    { value: "MHz", label: "MHz", factor: 1e-6 },
    { value: "GHz", label: "GHz", factor: 1e-9 },
  ],
};

export function formatDisplayUnitValue(value: number): string {
  return Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : "unknown";
}

export function formatValueWithUnit(
  value: number,
  unit: string | null | undefined,
): string {
  const valueLabel = formatDisplayUnitValue(value);
  const unitLabel = unit?.trim();
  return unitLabel && unitLabel !== "1" ? `${valueLabel} ${unitLabel}` : valueLabel;
}

export function displayUnitItemsForSourceUnit(
  sourceUnit: string | null | undefined,
): DisplayUnitItem[] {
  const definitions = displayUnitDefinitionsForSourceUnit(sourceUnit);
  return definitions.map(({ label, value }) => ({ label, value }));
}

export function hasDisplayUnitOptions(
  sourceUnit: string | null | undefined,
): boolean {
  return displayUnitDefinitionsForSourceUnit(sourceUnit).length > 1;
}

export function normalizeDisplayUnit(
  sourceUnit: string | null | undefined,
  displayUnit: string | null | undefined,
): string {
  const definitions = displayUnitDefinitionsForSourceUnit(sourceUnit);
  if (definitions.length === 0) return "";
  const candidate = displayUnit?.trim() ?? "";
  return (
    definitions.find((definition) => definition.value === candidate)?.value ??
    definitions[0]?.value ??
    ""
  );
}

export function formatValueWithDisplayUnit(
  value: number,
  sourceUnit: string | null | undefined,
  displayUnit: string | null | undefined,
): string {
  const normalizedDisplayUnit = normalizeDisplayUnit(sourceUnit, displayUnit);
  const definition = displayUnitDefinitionsForSourceUnit(sourceUnit).find(
    (item) => item.value === normalizedDisplayUnit,
  );
  if (!definition) {
    return formatValueWithUnit(value, sourceUnit);
  }
  return formatValueWithUnit(value * definition.factor, definition.value);
}

function displayUnitDefinitionsForSourceUnit(
  sourceUnit: string | null | undefined,
): DisplayUnitDefinition[] {
  return DISPLAY_UNITS_BY_SOURCE_UNIT[sourceUnit?.trim() ?? ""] ?? [];
}
