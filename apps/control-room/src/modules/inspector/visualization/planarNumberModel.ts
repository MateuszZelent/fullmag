import type { QuantityFieldParseResult } from "../primitives/QuantityField";

export interface PlanarNumberConstraints {
  integer?: boolean;
  maximum?: number;
  minimum?: number;
  minimumExclusive?: boolean;
}

const NUMBER_TEXT_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const INCOMPLETE_NUMBER_TEXT_PATTERNS = [
  /^[+-]?$/,
  /^[+-]?\.$/,
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))[eE][+-]?$/,
];

export function parsePlanarNumberText(
  text: string,
  constraints: PlanarNumberConstraints = {},
): QuantityFieldParseResult<number> {
  if (
    text === "" ||
    INCOMPLETE_NUMBER_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { message: "Complete the numeric value.", ok: false, status: "incomplete" };
  }
  if (!NUMBER_TEXT_PATTERN.test(text)) {
    return { message: "Enter a finite decimal number.", ok: false, status: "invalid" };
  }

  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { message: "Enter a finite decimal number.", ok: false, status: "invalid" };
  }
  if (constraints.integer && !Number.isInteger(value)) {
    return { message: "Enter a whole number.", ok: false, status: "invalid" };
  }
  if (
    constraints.minimum !== undefined &&
    (constraints.minimumExclusive
      ? value <= constraints.minimum
      : value < constraints.minimum)
  ) {
    const relation = constraints.minimumExclusive ? "greater than" : "at least";
    return {
      message: `Enter a value ${relation} ${constraints.minimum}.`,
      ok: false,
      status: "invalid",
    };
  }
  if (constraints.maximum !== undefined && value > constraints.maximum) {
    return {
      message: `Enter a value no greater than ${constraints.maximum}.`,
      ok: false,
      status: "invalid",
    };
  }
  return { ok: true, value };
}
