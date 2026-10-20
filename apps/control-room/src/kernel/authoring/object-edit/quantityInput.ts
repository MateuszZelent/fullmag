export type QuantityDimension =
  | "angle"
  | "dimensionless"
  | "frequency"
  | "length"
  | "time";

export type QuantityUnit =
  | "m"
  | "mm"
  | "um"
  | "µm"
  | "μm"
  | "nm"
  | "deg"
  | "°"
  | "rad"
  | "s"
  | "ms"
  | "us"
  | "µs"
  | "μs"
  | "ns"
  | "ps"
  | "fs"
  | "Hz"
  | "kHz"
  | "MHz"
  | "GHz"
  | "THz"
  | "1";

export type QuantityParseStatus = "empty" | "incomplete" | "invalid" | "valid";

export interface QuantityInputState {
  rawText: string;
  dimension: QuantityDimension;
  unit: QuantityUnit;
  parseStatus: QuantityParseStatus;
  parsedSI: number | null;
  lastValidSI: number | null;
}

export type QuantityUnitChangeResult =
  | { ok: true; input: QuantityInputState }
  | {
      ok: false;
      input: QuantityInputState;
      reason: "invalid-unit" | "incomplete" | "invalid" | "out-of-range";
    };

interface UnitDefinition {
  dimension: QuantityDimension;
  factorToSI: number;
}

const UNIT_DEFINITIONS: Record<QuantityUnit, UnitDefinition> = {
  "1": { dimension: "dimensionless", factorToSI: 1 },
  "°": { dimension: "angle", factorToSI: Math.PI / 180 },
  deg: { dimension: "angle", factorToSI: Math.PI / 180 },
  m: { dimension: "length", factorToSI: 1 },
  mm: { dimension: "length", factorToSI: 1e-3 },
  nm: { dimension: "length", factorToSI: 1e-9 },
  rad: { dimension: "angle", factorToSI: 1 },
  um: { dimension: "length", factorToSI: 1e-6 },
  "µm": { dimension: "length", factorToSI: 1e-6 },
  "μm": { dimension: "length", factorToSI: 1e-6 },
  s: { dimension: "time", factorToSI: 1 },
  ms: { dimension: "time", factorToSI: 1e-3 },
  us: { dimension: "time", factorToSI: 1e-6 },
  "µs": { dimension: "time", factorToSI: 1e-6 },
  "μs": { dimension: "time", factorToSI: 1e-6 },
  ns: { dimension: "time", factorToSI: 1e-9 },
  ps: { dimension: "time", factorToSI: 1e-12 },
  fs: { dimension: "time", factorToSI: 1e-15 },
  Hz: { dimension: "frequency", factorToSI: 1 },
  kHz: { dimension: "frequency", factorToSI: 1e3 },
  MHz: { dimension: "frequency", factorToSI: 1e6 },
  GHz: { dimension: "frequency", factorToSI: 1e9 },
  THz: { dimension: "frequency", factorToSI: 1e12 },
};

// Longer suffixes first so "ms"/"ns" never match as "s" and "GHz" never as "Hz".
const UNIT_SUFFIXES: readonly QuantityUnit[] = [
  "THz",
  "GHz",
  "MHz",
  "kHz",
  "Hz",
  "µs",
  "μs",
  "ms",
  "us",
  "ns",
  "ps",
  "fs",
  "µm",
  "μm",
  "deg",
  "mm",
  "nm",
  "um",
  "rad",
  "m",
  "°",
  "s",
];

const COMPLETE_NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;
const INCOMPLETE_EXPONENT =
  /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?$/;

export function defaultQuantityUnit(dimension: QuantityDimension): QuantityUnit {
  if (dimension === "angle") return "rad";
  if (dimension === "dimensionless") return "1";
  if (dimension === "time") return "s";
  if (dimension === "frequency") return "Hz";
  return "m";
}

function hasCompatibleUnit(
  dimension: QuantityDimension,
  unit: QuantityUnit,
): boolean {
  return UNIT_DEFINITIONS[unit]?.dimension === dimension;
}

function finiteSI(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberStatus(
  numericText: string,
): { status: "incomplete" | "invalid" } | { status: "valid"; value: number } {
  if (
    /^[+-]?$/.test(numericText) ||
    /^[+-]?[.,]$/.test(numericText) ||
    INCOMPLETE_EXPONENT.test(numericText)
  ) {
    return { status: "incomplete" };
  }

  if (!COMPLETE_NUMBER.test(numericText)) return { status: "invalid" };

  const value = Number(numericText.replace(",", "."));
  if (!Number.isFinite(value)) return { status: "invalid" };

  // Do not silently turn a non-zero literal into zero through f64 underflow.
  const mantissa = numericText.split(/[eE]/, 1)[0];
  if (value === 0 && /[1-9]/.test(mantissa)) return { status: "invalid" };

  return { status: "valid", value };
}

function makeInput(
  rawText: string,
  dimension: QuantityDimension,
  unit: QuantityUnit,
  parseStatus: QuantityParseStatus,
  parsedSI: number | null,
  lastValidSI: number | null,
): QuantityInputState {
  return {
    dimension,
    lastValidSI,
    parsedSI,
    parseStatus,
    rawText,
    unit,
  };
}

function invalidInput(
  rawText: string,
  dimension: QuantityDimension,
  unit: QuantityUnit,
  lastValidSI: number | null,
): QuantityInputState {
  return makeInput(rawText, dimension, unit, "invalid", null, lastValidSI);
}

function parseWithUnit(
  rawText: string,
  numericText: string,
  dimension: QuantityDimension,
  selectedUnit: QuantityUnit,
  parseUnit: QuantityUnit,
  lastValidSI: number | null,
): QuantityInputState {
  const definition = UNIT_DEFINITIONS[parseUnit];
  if (!definition || definition.dimension !== dimension) {
    return invalidInput(rawText, dimension, selectedUnit, lastValidSI);
  }

  const parsed = numberStatus(numericText);
  if (parsed.status !== "valid") {
    return makeInput(rawText, dimension, selectedUnit, parsed.status, null, lastValidSI);
  }

  const parsedSI = parsed.value * definition.factorToSI;
  if (
    !Number.isFinite(parsedSI) ||
    (parsed.value !== 0 && parsedSI === 0)
  ) {
    return invalidInput(rawText, dimension, selectedUnit, lastValidSI);
  }

  return makeInput(rawText, dimension, selectedUnit, "valid", parsedSI, parsedSI);
}

/**
 * Parses one scalar quantity while retaining its original text and the selected
 * control unit. Explicit suffixes affect interpretation but do not change the
 * selected unit stored in the result.
 */
export function parseQuantityInput(
  rawText: string,
  dimension: QuantityDimension,
  unit: QuantityUnit = defaultQuantityUnit(dimension),
  previousLastValidSI: number | null = null,
): QuantityInputState {
  const lastValidSI = finiteSI(previousLastValidSI);
  const trimmed = rawText.trim();

  if (!trimmed) {
    return makeInput(rawText, dimension, unit, "empty", null, lastValidSI);
  }
  if (!hasCompatibleUnit(dimension, unit)) {
    return invalidInput(rawText, dimension, unit, lastValidSI);
  }

  const plainNumber = numberStatus(trimmed);
  if (plainNumber.status !== "invalid") {
    return parseWithUnit(rawText, trimmed, dimension, unit, unit, lastValidSI);
  }

  const whitespace = trimmed.match(/\s/g) ?? [];
  if (whitespace.length > 1 || (whitespace.length === 1 && !trimmed.includes(" "))) {
    return invalidInput(rawText, dimension, unit, lastValidSI);
  }

  let numericText: string;
  let suffix: string;
  if (trimmed.includes(" ")) {
    const parts = trimmed.split(" ");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return invalidInput(rawText, dimension, unit, lastValidSI);
    }
    [numericText, suffix] = parts;
  } else {
    const matchedSuffix = UNIT_SUFFIXES.find((candidate) => trimmed.endsWith(candidate));
    if (!matchedSuffix) return invalidInput(rawText, dimension, unit, lastValidSI);
    suffix = matchedSuffix;
    numericText = trimmed.slice(0, -matchedSuffix.length);
  }

  const parseUnit = UNIT_SUFFIXES.find((candidate) => candidate === suffix);
  if (!parseUnit) return invalidInput(rawText, dimension, unit, lastValidSI);
  const definition = UNIT_DEFINITIONS[parseUnit];
  if (!definition || definition.dimension !== dimension) {
    return invalidInput(rawText, dimension, unit, lastValidSI);
  }
  if (!numericText) {
    return makeInput(rawText, dimension, unit, "incomplete", null, lastValidSI);
  }

  return parseWithUnit(rawText, numericText, dimension, unit, parseUnit, lastValidSI);
}

/**
 * Changes the selected unit without changing a valid quantity's SI value.
 * Empty fields may change units; invalid and incomplete fields are field-scoped
 * blockers and retain their original state.
 */
export function changeQuantityInputUnit(
  input: QuantityInputState,
  nextUnit: QuantityUnit,
): QuantityUnitChangeResult {
  if (!hasCompatibleUnit(input.dimension, nextUnit)) {
    return { input, ok: false, reason: "invalid-unit" };
  }
  if (input.parseStatus === "incomplete") {
    return { input, ok: false, reason: "incomplete" };
  }
  if (input.parseStatus === "invalid") {
    return { input, ok: false, reason: "invalid" };
  }
  if (input.parseStatus === "empty" || input.parsedSI === null) {
    return {
      input: makeInput(
        input.rawText,
        input.dimension,
        nextUnit,
        "empty",
        null,
        input.lastValidSI,
      ),
      ok: true,
    };
  }

  const valueInNextUnit = input.parsedSI / UNIT_DEFINITIONS[nextUnit].factorToSI;
  if (
    !Number.isFinite(valueInNextUnit) ||
    (input.parsedSI !== 0 && valueInNextUnit === 0)
  ) {
    return { input, ok: false, reason: "out-of-range" };
  }
  const rawText = String(valueInNextUnit);
  return {
    input: makeInput(
      rawText,
      input.dimension,
      nextUnit,
      "valid",
      input.parsedSI,
      input.parsedSI,
    ),
    ok: true,
  };
}
