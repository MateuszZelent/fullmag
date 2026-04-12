/**
 * @module lib/quantities/rendering
 *
 * Shape-driven renderer selection for quantities (QB-14).
 *
 * The UI must choose a renderer based on `QuantityShape`, not by
 * hard-coding per quantity name.  This module provides the mapping
 * and rendering metadata that the viewport and chart layers consume.
 */

import type { QuantityShape, NormalizationHint, QuantityDescriptor } from "./types";

// ── Renderer kind ────────────────────────────────────────────────

/**
 * The class of renderer a quantity requires.
 *   - `arrows`  → 3D vector glyph / LIC / HSL color map
 *   - `heatmap` → 2D / 3D scalar colour map
 *   - `card`    → scalar card / chart / table row
 */
export type RendererKind = "arrows" | "heatmap" | "card";

/** Map shape → renderer kind. */
export function rendererForShape(shape: QuantityShape): RendererKind {
  switch (shape) {
    case "vector_field":
      return "arrows";
    case "spatial_scalar":
      return "heatmap";
    case "global_scalar":
      return "card";
  }
}

// ── Color-scale helpers ──────────────────────────────────────────

export type ColorScaleKind = "diverging" | "sequential" | "cyclic";

/**
 * Choose color-scale strategy from the normalization hint.
 *   - `unit_vector`  → diverging  (values in [-1, 1])
 *   - `max_abs`      → diverging  (symmetric around 0)
 *   - `none`         → sequential (raw positive values, e.g. energy)
 */
export function colorScaleForHint(hint: NormalizationHint): ColorScaleKind {
  switch (hint) {
    case "unit_vector":
    case "max_abs":
      return "diverging";
    case "none":
      return "sequential";
  }
}

// ── Render metadata bundle ───────────────────────────────────────

export interface QuantityRenderMeta {
  renderer: RendererKind;
  colorScale: ColorScaleKind;
  unitLabel: string;
  nComp: number;
}

/** Derive all rendering metadata from a descriptor. */
export function renderMetaFor(desc: QuantityDescriptor): QuantityRenderMeta {
  return {
    renderer: rendererForShape(desc.shape),
    colorScale: colorScaleForHint(desc.normalizationHint),
    unitLabel: desc.unit === "dimensionless" ? "" : desc.unit,
    nComp: desc.nComp,
  };
}
