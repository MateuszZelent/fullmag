import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";

export interface VectorGlyph {
  index: number;
  normal: number;
  u: number;
  v: number;
  origNormal?: number;
  origU?: number;
  origV?: number;
  worldU?: number;
  worldV?: number;
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

export interface BuildVectorGlyphsOptions {
  bounds?: readonly [number, number, number, number];
  gridHeight?: number;
  gridWidth?: number;
  lengthMode?: string;
  mask?: ArrayLike<number>;
  maxLengthCells?: number;
  referenceValue?: number;
  vectorScale?: number;
}

export function buildVectorGlyphs(
  vectors: ArrayLike<number>,
  budget: number,
  epsilon = 1e-15,
  options: BuildVectorGlyphsOptions = {},
): VectorGlyph[] {
  const available = Math.floor(vectors.length / 3);
  const count = Math.max(0, Math.min(available, Math.floor(budget)));
  if (count === 0) return [];

  // If 2D grid dimensions are provided, perform deterministic screen/grid tile sampling
  if (options.gridWidth && options.gridHeight && options.gridWidth > 0 && options.gridHeight > 0) {
    const width = options.gridWidth;
    const height = options.gridHeight;
    const aspect = width / height;

    const nx = Math.max(1, Math.min(width, Math.round(Math.sqrt(count * aspect))));
    const ny = Math.max(1, Math.min(height, Math.round(count / nx)));

    // Reference magnitude across dataset for scaling
    let refMag = options.referenceValue ?? 0;
    if (refMag <= 0) {
      for (let i = 0; i < available; i++) {
        const offset = i * 3;
        const u = vectors[offset] ?? 0;
        const v = vectors[offset + 1] ?? 0;
        const n = vectors[offset + 2] ?? 0;
        if (Number.isFinite(u) && Number.isFinite(v) && Number.isFinite(n)) {
          const m = Math.hypot(u, v, n);
          if (m > refMag) refMag = m;
        }
      }
    }
    if (refMag <= 0) refMag = 1;

    const glyphs: VectorGlyph[] = [];
    const maximum = Math.max(0, options.maxLengthCells ?? 0.4);

    for (let ty = 0; ty < ny; ty++) {
      const y0 = Math.floor((ty * height) / ny);
      const y1 = Math.min(height, Math.floor(((ty + 1) * height) / ny));
      for (let tx = 0; tx < nx; tx++) {
        const x0 = Math.floor((tx * width) / nx);
        const x1 = Math.min(width, Math.floor(((tx + 1) * width) / nx));

        const cx = Math.floor((x0 + x1) / 2);
        const cy = Math.floor((y0 + y1) / 2);

        // Check if center is occupied; if not, search tile for valid occupied cell
        let chosenX = -1;
        let chosenY = -1;
        if (!options.mask || isRenderablePlanarOccupancy(options.mask[cy * width + cx])) {
          chosenX = cx;
          chosenY = cy;
        } else {
          for (let y = y0; y < y1 && chosenX === -1; y++) {
            for (let x = x0; x < x1 && chosenX === -1; x++) {
              if (isRenderablePlanarOccupancy(options.mask[y * width + x])) {
                chosenX = x;
                chosenY = y;
              }
            }
          }
        }
        if (chosenX === -1) continue; // Tile has no occupied cells

        const index = chosenY * width + chosenX;
        const offset = index * 3;
        const u = vectors[offset] ?? 0;
        const v = vectors[offset + 1] ?? 0;
        const normal = vectors[offset + 2] ?? 0;

        if (![u, v, normal].every(Number.isFinite)) continue;
        const mag = Math.hypot(u, v, normal);
        if (mag <= epsilon) continue;

        const inPlane = Math.hypot(u, v);
        let scale = 1;
        if (options.lengthMode === "magnitude") {
          const norm = Math.min(1, mag / refMag);
          const target = maximum * norm;
          scale = inPlane > epsilon ? target / inPlane : 1;
        } else {
          scale = inPlane > epsilon ? maximum / inPlane : 1;
        }

        const [uMin, uMax, vMin, vMax] = options.bounds ?? [0, width, 0, height];
        const worldU = uMin + (chosenX + 0.5) * ((uMax - uMin) / width);
        const worldV = vMin + (chosenY + 0.5) * ((vMax - vMin) / height);

        glyphs.push({
          index,
          normal,
          origNormal: normal,
          origU: u,
          origV: v,
          u: u * scale,
          v: v * scale,
          worldU,
          worldV,
        });
      }
    }
    return glyphs;
  }

  // 1D stratified sampling fallback
  const glyphs: VectorGlyph[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const index = Math.min(
      available - 1,
      Math.floor(((slot + 0.5) * available) / count),
    );
    const offset = index * 3;
    const u = vectors[offset] ?? 0;
    const v = vectors[offset + 1] ?? 0;
    const normal = vectors[offset + 2] ?? 0;
    if (![u, v, normal].every(Number.isFinite)) continue;
    const length = Math.hypot(u, v);
    if (Math.hypot(u, v, normal) <= epsilon) continue;
    const maximum = Math.max(0, options.maxLengthCells ?? 0.4);
    const scale = options.lengthMode === "magnitude"
      ? length > maximum && length > 0 ? maximum / length : 1
      : length > epsilon ? maximum / length : 1;
    glyphs.push({
      index,
      normal,
      origNormal: normal,
      origU: u,
      origV: v,
      u: u * scale,
      v: v * scale,
    });
  }
  return glyphs;
}
