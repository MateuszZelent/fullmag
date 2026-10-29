import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";
import {
  resolveScalarRange,
  type ScalarRange,
  type Viewport3DFieldVector,
} from "../viewport3dFieldMapping";
import { normalizeViewport3DScalarColorValue } from "../viewport3dVectorColoring";
import type { Viewport3DVisibleColorScale } from "./viewport3DVisibleColorScale";

interface PhysicalGlyphColors {
  colors: Float32Array;
  scale: Viewport3DVisibleColorScale;
}

const MAX_STYLES_PER_FIELD = 16;
const glyphColors = new WeakMap<
  Uint32Array,
  WeakMap<Viewport3DFieldVector, Map<string, PhysicalGlyphColors>>
>();

function validRange(range: ScalarRange): boolean {
  return Number.isFinite(range.min) && Number.isFinite(range.max) &&
    range.max >= range.min;
}

/** Color emitted glyphs from their physical samples, never their display lengths. */
export function buildViewport3DPhysicalGlyphColors({
  field,
  sampleIndices,
  colorMode,
  palette,
  range,
}: {
  field: Viewport3DFieldVector;
  /** Field-local indices captured when the corresponding glyphs were built. */
  sampleIndices: Uint32Array;
  colorMode: string;
  palette: string;
  range?: ScalarRange | null;
}): PhysicalGlyphColors | null {
  if (field.nComp !== 3 || !["magnitude", "x", "y", "z"].includes(colorMode)) return null;
  if (range && !validRange(range)) return null;
  let byField = glyphColors.get(sampleIndices);
  if (!byField) {
    byField = new WeakMap();
    glyphColors.set(sampleIndices, byField);
  }
  let byStyle = byField.get(field);
  if (!byStyle) {
    byStyle = new Map();
    byField.set(field, byStyle);
  }
  const key = JSON.stringify([colorMode, palette, range?.min ?? null, range?.max ?? null]);
  const cached = byStyle.get(key);
  if (cached) {
    byStyle.delete(key);
    byStyle.set(key, cached);
    return cached;
  }
  const physicalRange = range ?? resolveScalarRange(field, colorMode, palette);
  if (!validRange(physicalRange)) return null;
  const colors = new Float32Array(sampleIndices.length * 3);
  for (let glyph = 0; glyph < sampleIndices.length; glyph += 1) {
    const index = sampleIndices[glyph]!;
    if (index >= field.pointCount || index * 3 + 2 >= field.values.length) return null;
    const x = field.values[index * 3]!;
    const y = field.values[index * 3 + 1]!;
    const z = field.values[index * 3 + 2]!;
    const value = colorMode === "x" ? x
      : colorMode === "y" ? y
      : colorMode === "z" ? z
      : Math.hypot(x, y, z);
    if (!Number.isFinite(value)) return null;
    colors.set(
      scalarColorRgb(normalizeViewport3DScalarColorValue(value, physicalRange), palette),
      glyph * 3,
    );
  }
  const result: PhysicalGlyphColors = {
    colors,
    scale: {
      colorMode,
      colorPalette: palette,
      quantityId: field.quantityId,
      range: { ...physicalRange },
    },
  };
  byStyle.set(key, result);
  if (byStyle.size > MAX_STYLES_PER_FIELD) {
    const oldest = byStyle.keys().next().value;
    if (oldest !== undefined) byStyle.delete(oldest);
  }
  return result;
}
