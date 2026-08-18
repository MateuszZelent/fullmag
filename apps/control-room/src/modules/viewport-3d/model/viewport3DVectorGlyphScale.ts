const MIN_VECTOR_GLYPH_LENGTH = 1e-12;
const FULL_SPACING_FILL = 0.42;
const SURFACE_SPACING_FILL = 0.5;

export interface Viewport3DAdaptiveVectorGlyphLengthInput {
  boundsSize: readonly number[];
  glyphCount: number;
  lengthScale: number;
  scope: "full" | "surface";
}

export function resolveViewport3DAdaptiveVectorGlyphLength({
  boundsSize,
  glyphCount,
  lengthScale,
  scope,
}: Viewport3DAdaptiveVectorGlyphLengthInput): number {
  const dimensions = boundsSize
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left);
  const count = Math.max(1, Math.floor(Number.isFinite(glyphCount) ? glyphCount : 0));
  const multiplier = Math.max(0, Number.isFinite(lengthScale) ? lengthScale : 1);
  if (dimensions.length === 0 || multiplier === 0) return MIN_VECTOR_GLYPH_LENGTH;
  const dimensionality = scope === "surface"
    ? Math.min(2, dimensions.length)
    : Math.min(3, dimensions.length);
  const measure = dimensions.slice(0, dimensionality).reduce((product, value) => product * value, 1);
  const spacing = Math.pow(measure / count, 1 / dimensionality);
  const fill = scope === "surface" ? SURFACE_SPACING_FILL : FULL_SPACING_FILL;
  return Math.max(spacing * fill * multiplier, MIN_VECTOR_GLYPH_LENGTH);
}
