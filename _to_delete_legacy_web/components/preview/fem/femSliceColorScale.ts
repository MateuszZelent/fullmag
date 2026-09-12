/**
 * Colour-scale logic for 2D FEM slices.
 *
 * Computes the effective min/max and palette mode from the
 * `ColorScaleMode` in the `FemSliceQuery` combined with the
 * actual data range of the current slice.
 */

import type { ColorScaleMode } from "./femSliceQuery";
import type { SliceValueRange } from "./femSliceExact";
import { DIVERGING_PALETTE, POSITIVE_PALETTE, SEQUENTIAL_BLUE_PALETTE } from "../../../lib/colorPalettes";

// ── Types ────────────────────────────────────────────────────────

export type PaletteMode = "diverging" | "positive" | "negative";

export interface ResolvedColorScale {
  min: number;
  max: number;
  mode: PaletteMode;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Resolve the effective colour scale.
 *
 * @param dataRange      The actual min/max from the current slice result.
 * @param colorScaleMode The user's chosen mode from the query.
 * @param lockedRange    If `locked_manual`, the user-pinned [min, max].
 * @param quantityId     Quantity id for magnetization heuristics.
 * @param component      Component for magnetization heuristics.
 * @param globalRange    Optional full-quantity range for `global_auto`.
 */
export function resolveColorScale(args: {
  dataRange: SliceValueRange;
  colorScaleMode: ColorScaleMode;
  lockedRange?: [number, number];
  quantityId?: string;
  component?: string;
  globalRange?: SliceValueRange;
}): ResolvedColorScale {
  const { dataRange, colorScaleMode, lockedRange, quantityId, component, globalRange } = args;

  switch (colorScaleMode) {
    case "locked_manual": {
      const [lo, hi] = lockedRange ?? [dataRange.min, dataRange.max];
      return { min: lo, max: hi, mode: inferPaletteMode(lo, hi) };
    }
    case "global_auto": {
      const range = globalRange ?? dataRange;
      return smartAutoScale(range.min, range.max, quantityId, component);
    }
    case "symmetric_zero": {
      const bound = Math.max(Math.abs(dataRange.min), Math.abs(dataRange.max));
      return { min: -bound, max: bound, mode: "diverging" };
    }
    case "slice_auto":
    default:
      return smartAutoScale(dataRange.min, dataRange.max, quantityId, component);
  }
}

/**
 * Smart auto scale — backward compatible with `getSmartColorScale`
 * from femSliceUtils.ts.
 */
export function smartAutoScale(
  dMin: number,
  dMax: number,
  quantityId?: string,
  component?: string,
): ResolvedColorScale {
  const isMag = !quantityId || quantityId === "m";

  if (isMag) {
    if (component === "magnitude") return { min: 0, max: 1, mode: "positive" };
    return { min: -1, max: 1, mode: "diverging" };
  }

  let min = dMin;
  let max = dMax;
  const range = max - min;
  if (range > 0 && range < Math.abs(max) * 1e-10) {
    const mid = (min + max) / 2;
    const hs = Math.abs(mid) * 0.01 || 1e-20;
    min = mid - hs;
    max = mid + hs;
  }

  if (min < 0 && max > 0) {
    const bound = Math.max(Math.abs(min), Math.abs(max));
    return { min: -bound, max: bound, mode: "diverging" };
  }
  if (max <= 0) return { min, max, mode: "negative" };
  return { min, max, mode: "positive" };
}

// ── Palette helpers ──────────────────────────────────────────────

const DIVERGING = [...DIVERGING_PALETTE];
const POSITIVE = [...POSITIVE_PALETTE];
const NEGATIVE = [...SEQUENTIAL_BLUE_PALETTE];

export function paletteForMode(mode: PaletteMode): string[] {
  switch (mode) {
    case "diverging": return DIVERGING;
    case "positive":  return POSITIVE;
    case "negative":  return NEGATIVE;
  }
}

export function interpolatePalette(t: number, palette: string[]): string {
  const n = palette.length - 1;
  const scaled = Math.max(0, Math.min(1, t)) * n;
  const index = Math.min(Math.floor(scaled), n - 1);
  const frac = scaled - index;
  const a = palette[index];
  const b = palette[index + 1];
  if (frac <= 1e-6) return a;
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * frac);
  return `rgb(${mix(ar, br)}, ${mix(ag, bg)}, ${mix(ab, bb)})`;
}

/** Map a scalar value to a colour string. */
export function colorForValue(
  value: number,
  scale: ResolvedColorScale,
  quantityId?: string,
): string {
  const t = scale.max > scale.min ? (value - scale.min) / (scale.max - scale.min) : 0.5;
  return interpolatePalette(t, paletteForMode(scale.mode));
}

// ── Internal ─────────────────────────────────────────────────────

function inferPaletteMode(min: number, max: number): PaletteMode {
  if (min < 0 && max > 0) return "diverging";
  if (max <= 0) return "negative";
  return "positive";
}
