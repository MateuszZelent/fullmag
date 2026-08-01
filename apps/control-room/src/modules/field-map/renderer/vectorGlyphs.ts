export interface VectorGlyph {
  index: number;
  normal: number;
  u: number;
  v: number;
}

export function buildVectorGlyphs(
  vectors: ArrayLike<number>,
  budget: number,
  epsilon = 1e-15,
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
    if (Math.hypot(u, v, normal) <= epsilon) continue;
    glyphs.push({ index, normal, u, v });
  }
  return glyphs;
}
