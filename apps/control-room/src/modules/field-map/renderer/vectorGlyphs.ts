export interface VectorGlyph {
  index: number;
  normal: number;
  u: number;
  v: number;
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

export function buildVectorGlyphs(
  vectors: ArrayLike<number>,
  budget: number,
  epsilon = 1e-15,
  options: { lengthMode?: string; maxLengthCells?: number } = {},
): VectorGlyph[] {
  const available = Math.floor(vectors.length / 3);
  const count = Math.max(0, Math.min(available, Math.floor(budget)));
  if (count === 0) return [];
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
    glyphs.push({ index, normal, u: u * scale, v: v * scale });
  }
  return glyphs;
}
