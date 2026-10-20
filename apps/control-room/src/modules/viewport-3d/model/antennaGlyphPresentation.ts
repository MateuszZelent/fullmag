/** Explicit global display multiplier, anchored at each sample; never normalizes individual vectors. */
export function scaleAntennaGlyphSegments(segments: Float32Array | null, scale: number): Float32Array | null {
  if (![1, 2, 4].includes(scale)) throw new Error("Unsupported antenna glyph length multiplier.");
  if (!segments || scale === 1) return segments;
  const result = segments.slice();
  for (let offset = 0; offset < segments.length; offset += 6) for (let axis = 0; axis < 3; axis++) {
    const start = segments[offset + axis];
    const end = start + (segments[offset + axis + 3] - start) * scale;
    if (!Number.isFinite(Math.fround(end))) throw new Error("Scaled antenna glyph cannot be represented. Choose a smaller display multiplier.");
    result[offset + axis + 3] = end;
  }
  return result;
}

/** Pack the known six-coordinate antenna carrier into the renderer's seven-channel format. */
export function encodeAntennaGlyphSegments(segments: Float32Array | null, count: number): Float32Array | null {
  if (!segments) return null;
  if (!Number.isSafeInteger(count) || count <= 0 || segments.length !== count * 6) throw new Error("Antenna glyph cardinality differs from its sample carrier.");
  let maximumLength = 0;
  for (let offset = 0; offset < segments.length; offset += 6) {
    for (let axis = 0; axis < 6; axis++) if (!Number.isFinite(segments[offset + axis])) throw new Error("Non-finite antenna glyph coordinate.");
    maximumLength = Math.max(maximumLength, Math.hypot(segments[offset + 3] - segments[offset], segments[offset + 4] - segments[offset + 1], segments[offset + 5] - segments[offset + 2]));
  }
  const result = new Float32Array(count * 7);
  for (let index = 0; index < count; index++) {
    const source = index * 6, target = index * 7;
    for (let axis = 0; axis < 6; axis++) result[target + axis] = segments[source + axis];
    const length = Math.hypot(segments[source + 3] - segments[source], segments[source + 4] - segments[source + 1], segments[source + 5] - segments[source + 2]);
    result[target + 6] = maximumLength > 0 ? length / maximumLength : 0;
  }
  return result;
}
