import type { QuantityFieldParseResult } from "../../primitives/QuantityField";

/** Decimal/scientific input; a missing component must never become zero. */
export function parseSelectionNumber(text: string, min?: number, max?: number): QuantityFieldParseResult<number> {
  const raw = text.trim();
  if (!raw || /^[+-]?\.?$/.test(raw) || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?$/.test(raw)) {
    return { ok: false, status: "incomplete", message: "Enter a complete finite number." };
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) {
    return { ok: false, status: "invalid", message: "Enter a finite decimal or scientific number." };
  }
  const value = Number(raw);
  if (min !== undefined && value < min) return { ok: false, status: "invalid", message: `Must be at least ${min}.` };
  if (max !== undefined && value > max) return { ok: false, status: "invalid", message: `Must be at most ${max}.` };
  return { ok: true, value };
}

export function parseSelectionVector(text: string, dimension: number): QuantityFieldParseResult<number[]> {
  const entries = text.split(",");
  if (entries.length !== dimension) {
    return { ok: false, status: entries.length < dimension ? "incomplete" : "invalid", message: `Enter exactly ${dimension} comma-separated components.` };
  }
  const values: number[] = [];
  for (const entry of entries) {
    const parsed = parseSelectionNumber(entry);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  return { ok: true, value: values };
}
