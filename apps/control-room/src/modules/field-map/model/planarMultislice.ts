import { resolvePlanarDisplayUnit, type PlanarDisplayRange } from "./fieldMapRenderModel";

/** Extrema of one panel over renderable samples. */
export interface MultisliceExtent {
  max: number;
  min: number;
}

export const MULTISLICE_MIN_PANELS = 2;
export const MULTISLICE_MAX_PANELS = 4;

/**
 * Shared colour range of multislice panels (note 0970 § Multislice panels):
 * `manual` applies unchanged; `auto` is the union of the panel extrema and
 * `symmetric` its largest magnitude. Null until every panel has an extent.
 */
export function resolveMultisliceRange(
  requested: PlanarDisplayRange | null,
  extents: readonly (MultisliceExtent | null)[],
): MultisliceExtent | null {
  if (!requested) return null;
  if (requested.mode === "manual") {
    const { max, min } = requested;
    return Number.isFinite(min) && Number.isFinite(max) && max! > min! ? { max: max!, min: min! } : null;
  }
  if (extents.length === 0 || extents.some((extent) => extent === null)) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const extent of extents as readonly MultisliceExtent[]) {
    min = Math.min(min, extent.min);
    max = Math.max(max, extent.max);
  }
  if (requested.mode === "symmetric") {
    const magnitude = Math.max(Math.abs(min), Math.abs(max));
    return { max: magnitude, min: -magnitude };
  }
  return { max, min };
}

/** Evenly spaced default fractions for `count` panels, excluding the faces. */
export function evenMultisliceFractions(count: number): number[] {
  const panels = Math.min(MULTISLICE_MAX_PANELS, Math.max(MULTISLICE_MIN_PANELS, Math.round(count)));
  return Array.from({ length: panels }, (_, index) => (index + 1) / (panels + 1));
}

/** Unit and value scale of the multislice colour legend. */
export interface MultisliceLegendUnit {
  legendUnit: string;
  probeScale: number;
}

/**
 * Legend unit of the multislice panels. In the layers model the panels draw a
 * field layer whose quantity may differ from the base sample, so the legend
 * uses the layer's canonical unit as the panels' metadata reports it (layers
 * are drawn in their canonical unit, as in the composite). Without that
 * metadata yet, the unit is unknown rather than borrowed from the base field.
 */
export function multisliceLegendUnit(
  layerModel: boolean,
  panelCanonicalUnit: string | null,
  base: MultisliceLegendUnit,
): MultisliceLegendUnit {
  if (!layerModel) return base;
  if (!panelCanonicalUnit) return { legendUnit: "", probeScale: 1 };
  const resolved = resolvePlanarDisplayUnit(panelCanonicalUnit, panelCanonicalUnit);
  return { legendUnit: resolved.unit, probeScale: resolved.scale };
}
