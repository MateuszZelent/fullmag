/**
 * Screen-space quiver layout for the planar field map.
 *
 * Glyphs sit on a regular 2D grid in canvas pixels (not a 1D stride over the
 * row-major raster), anchored to the physical (u, v) frame so panning does not
 * make them drift over the data. Each glyph takes the value of the raster cell
 * that contains its anchor. Length follows mumax3: the in-plane projection of
 * the vector, so an out-of-plane vector shrinks; below a projection threshold
 * the glyph becomes a signed normal marker (⊙ out of plane, ⊗ into plane).
 */
import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";

export interface ScreenGlyph {
  /** Canvas-pixel anchor (glyph centre). */
  x: number;
  y: number;
  /** Raster cell the value came from. */
  index: number;
  /** Frame components of the sampled vector. */
  u: number;
  v: number;
  normal: number;
  /** Screen angle in radians (canvas y grows downwards). */
  angle: number;
  /** Arrow length in canvas pixels; 0 for a normal marker. */
  length: number;
  /** |v| / max |v| over the raster, in [0, 1]. */
  magnitudeRatio: number;
  kind: "arrow" | "out-of-plane" | "into-plane";
}

export interface ScreenGlyphLayoutInput {
  /** u, v, normal per raster cell, row-major from the minimum v row. */
  vectors: ArrayLike<number>;
  gridWidth: number;
  gridHeight: number;
  /** Physical sample bounds [uMin, uMax, vMin, vMax]. */
  bounds: readonly [number, number, number, number];
  /** Physical visible window [uMin, uMax, vMin, vMax]. */
  viewport: readonly [number, number, number, number];
  canvasWidth: number;
  canvasHeight: number;
  spacingPx: number;
  /** Multiplier on the default arrow length (planar vector style scale). */
  scale?: number;
  /** "uniform": direction only (mumax3); "magnitude": length ∝ |v| / max |v|. */
  lengthMode?: string;
  /** Occupancy codes aligned with the raster (0 occupied, 1 empty, ...); empty cells get no glyph. */
  mask?: ArrayLike<number> | null;
  maxGlyphs?: number;
}

/** Fraction of the grid spacing used by a full-length arrow. */
export const GLYPH_LENGTH_FRACTION = 0.82;
/** Shortest arrow drawn, in canvas pixels; shorter would be unreadable. */
export const GLYPH_MIN_LENGTH_PX = 7;
/** Below this in-plane fraction |v∥| / |v| the glyph is a normal marker. */
export const GLYPH_NORMAL_MARKER_THRESHOLD = 0.25;
const GLYPH_ZERO_NORM = 1e-30;
const DEFAULT_MAX_GLYPHS = 20_000;

/** Grid spacing (canvas px) that yields about `budget` glyphs over the canvas. */
export function glyphSpacingForBudget(
  canvasWidth: number,
  canvasHeight: number,
  budget: number,
  minimumPx = 24,
  maximumPx = 160,
): number {
  const area = Math.max(0, canvasWidth) * Math.max(0, canvasHeight);
  if (!(area > 0) || !(budget > 0)) return maximumPx;
  return Math.min(maximumPx, Math.max(minimumPx, Math.sqrt(area / budget)));
}

export function maxVectorMagnitude(vectors: ArrayLike<number>): number {
  let max = 0;
  for (let offset = 0; offset + 2 < vectors.length; offset += 3) {
    const magnitude = Math.hypot(vectors[offset]!, vectors[offset + 1]!, vectors[offset + 2]!);
    if (Number.isFinite(magnitude) && magnitude > max) max = magnitude;
  }
  return max;
}

export function layoutScreenGlyphs(input: ScreenGlyphLayoutInput): ScreenGlyph[] {
  const { bounds, viewport, canvasWidth, canvasHeight, gridWidth, gridHeight } = input;
  const spacing = input.spacingPx;
  const boundsU = bounds[1] - bounds[0];
  const boundsV = bounds[3] - bounds[2];
  const viewU = viewport[1] - viewport[0];
  const viewV = viewport[3] - viewport[2];
  if (
    !(spacing > 0) || !(canvasWidth > 0) || !(canvasHeight > 0) ||
    !(boundsU > 0) || !(boundsV > 0) || !(viewU > 0) || !(viewV > 0) ||
    gridWidth < 1 || gridHeight < 1 ||
    input.vectors.length < gridWidth * gridHeight * 3
  ) {
    return [];
  }
  const maxMagnitude = maxVectorMagnitude(input.vectors);
  if (!(maxMagnitude > GLYPH_ZERO_NORM)) return [];
  const stepU = spacing * (viewU / canvasWidth);
  const stepV = spacing * (viewV / canvasHeight);
  const fullLength = GLYPH_LENGTH_FRACTION * spacing * Math.max(0, input.scale ?? 1);
  const magnitudeMode = input.lengthMode === "magnitude";
  const maxGlyphs = input.maxGlyphs ?? DEFAULT_MAX_GLYPHS;
  // Anchor the grid to the sample bounds so pan keeps glyphs on the same data.
  const firstColumn = Math.max(0, Math.ceil((viewport[0] - bounds[0]) / stepU - 0.5));
  const firstRow = Math.max(0, Math.ceil((viewport[2] - bounds[2]) / stepV - 0.5));
  const glyphs: ScreenGlyph[] = [];
  for (let row = firstRow; ; row += 1) {
    const v = bounds[2] + (row + 0.5) * stepV;
    if (v > viewport[3] || v > bounds[3]) break;
    const cellRow = Math.floor(((v - bounds[2]) / boundsV) * gridHeight);
    if (cellRow < 0 || cellRow >= gridHeight) continue;
    const y = canvasHeight - ((v - viewport[2]) / viewV) * canvasHeight;
    for (let column = firstColumn; ; column += 1) {
      const u = bounds[0] + (column + 0.5) * stepU;
      if (u > viewport[1] || u > bounds[1]) break;
      const cellColumn = Math.floor(((u - bounds[0]) / boundsU) * gridWidth);
      if (cellColumn < 0 || cellColumn >= gridWidth) continue;
      const index = cellRow * gridWidth + cellColumn;
      if (input.mask && !isRenderablePlanarOccupancy(input.mask[index])) continue;
      const vu = input.vectors[index * 3]!;
      const vv = input.vectors[index * 3 + 1]!;
      const vn = input.vectors[index * 3 + 2]!;
      if (!Number.isFinite(vu) || !Number.isFinite(vv) || !Number.isFinite(vn)) continue;
      const magnitude = Math.hypot(vu, vv, vn);
      if (!(magnitude > GLYPH_ZERO_NORM)) continue;
      const inPlane = Math.hypot(vu, vv);
      const base = {
        index,
        magnitudeRatio: Math.min(1, magnitude / maxMagnitude),
        normal: vn,
        u: vu,
        v: vv,
        x: ((u - viewport[0]) / viewU) * canvasWidth,
        y,
      };
      if (inPlane / magnitude < GLYPH_NORMAL_MARKER_THRESHOLD) {
        glyphs.push({ ...base, angle: 0, kind: vn >= 0 ? "out-of-plane" : "into-plane", length: 0 });
      } else {
        const projected = magnitudeMode ? inPlane / maxMagnitude : inPlane / magnitude;
        glyphs.push({
          ...base,
          angle: Math.atan2(-vv, vu),
          kind: "arrow",
          length: Math.max(GLYPH_MIN_LENGTH_PX, fullLength * projected),
        });
      }
      if (glyphs.length >= maxGlyphs) return glyphs;
    }
  }
  return glyphs;
}

export function normalComponentMarker(value: number): {
  direction: "into-plane" | "out-of-plane";
  magnitude: number;
} {
  return {
    direction: value < 0 ? "into-plane" : "out-of-plane",
    magnitude: Math.abs(value),
  };
}
