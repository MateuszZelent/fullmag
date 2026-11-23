const UNICODE_MINUS = "\u2212";
const STRICT_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function withUnicodeMinus(formatted: string): string {
  return formatted.replace(/^-/, UNICODE_MINUS).replace(/e-/i, `e${UNICODE_MINUS}`);
}

export function formatNumericScalar(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Object.is(value, -0) || value === 0) return "0";

  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-3) {
    const [mantissa = "0", exponent = "0"] = value.toExponential(5).split("e");
    const cleanMantissa = String(Number.parseFloat(mantissa));
    const cleanExponent = Number.parseInt(exponent, 10);
    return withUnicodeMinus(`${cleanMantissa}e${cleanExponent}`);
  }

  return withUnicodeMinus(String(Number.parseFloat(value.toPrecision(6))));
}

/**
 * Formats an SI numeric value for display in the selected unit (`display = siValue / toSiFactor`).
 * Returns an empty string when `siValue` is non-finite or `toSiFactor` is non-positive/non-finite.
 */
export function formatQuantityDisplay(siValue: number, toSiFactor: number): string {
  if (!Number.isFinite(siValue) || !Number.isFinite(toSiFactor) || toSiFactor <= 0) {
    return "";
  }
  const displayValue = siValue / toSiFactor;
  return formatNumericScalar(displayValue);
}

/**
 * Parses a raw user-entered string in the current display unit into an SI number.
 * Returns `null` (never `NaN`) for incomplete intermediate strings such as `""`, `"-"`, `"1.5e-"`, or `"."`.
 */
export function parseQuantityInputToSI(rawText: string, toSiFactor: number): number | null {
  if (!Number.isFinite(toSiFactor) || toSiFactor <= 0) {
    return null;
  }

  const normalized = rawText
    .trim()
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/,/g, ".")
    .replace(/[\s\u00a0\u2009]/g, "")
    .replace(/[×x*]10\^?/i, "e");

  if (!STRICT_NUMBER_RE.test(normalized)) {
    return null;
  }

  const parsedDisplay = Number(normalized);
  if (!Number.isFinite(parsedDisplay)) {
    return null;
  }

  const siValue = parsedDisplay * toSiFactor;
  if (!Number.isFinite(siValue)) {
    return null;
  }

  return Object.is(siValue, -0) || siValue === 0 ? 0 : siValue;
}

export interface DragScrubParams {
  startValueSI: number;
  deltaPx: number;
  stepDisplay: number;
  toSiFactor: number;
  mode: "lin" | "log";
  shiftKey: boolean;
  altKey: boolean;
  min?: number;
  max?: number;
}

/**
 * Computes the next SI value during horizontal symbol drag-scrubbing.
 * - Linear mode: `v0 + deltaPx * modifier * stepDisplay * toSiFactor`
 * - Logarithmic mode (for positive `startValueSI`): `v0 * 10^((deltaPx * modifier) / 120)`
 *   where 120 px equals one decade (`10x`), `Shift` accelerates `10x`, and `Alt` slows to `0.1x`.
 */
export function computeDragScrubValueSI(params: DragScrubParams): number {
  const {
    startValueSI,
    deltaPx,
    stepDisplay,
    toSiFactor,
    mode,
    shiftKey,
    altKey,
    min,
    max,
  } = params;

  const modifier = shiftKey ? 10 : altKey ? 0.1 : 1;
  const safeStep = Number.isFinite(stepDisplay) && stepDisplay > 0 ? stepDisplay : 0.01;
  const safeFactor = Number.isFinite(toSiFactor) && toSiFactor > 0 ? toSiFactor : 1;

  let next =
    mode === "log" && startValueSI > 0
      ? startValueSI * Math.pow(10, (deltaPx * modifier) / 120)
      : startValueSI + deltaPx * modifier * safeStep * safeFactor;

  if (!Number.isFinite(next)) {
    next = startValueSI;
  }

  if (next !== 0) {
    next = Number(next.toPrecision(12));
  }

  if (min !== undefined && Number.isFinite(min) && next < min) {
    next = min;
  }
  if (max !== undefined && Number.isFinite(max) && next > max) {
    next = max;
  }

  return Object.is(next, -0) || next === 0 ? 0 : next;
}

export function inspectorValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => inspectorValuesEqual(entry, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    if (leftEntries.length !== Object.keys(rightRecord).length) return false;
    return leftEntries.every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      inspectorValuesEqual(value, rightRecord[key]),
    );
  }
  return false;
}
