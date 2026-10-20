/** Presentation limits in the selected quantity's SI units; never changes field data. */
export interface AntennaColorRange { minimum: number; maximum: number; }

export function parseAntennaColorRange(minimum: string, maximum: string): AntennaColorRange {
  const range = { minimum: Number(minimum), maximum: Number(maximum) };
  if (!minimum.trim() || !maximum.trim() || !validAntennaColorRange(range)) {
    throw new Error("Color limits must be finite SI values with minimum < maximum.");
  }
  return range;
}

export function validAntennaColorRange(range: AntennaColorRange): boolean {
  return Number.isFinite(range.minimum) && Number.isFinite(range.maximum) && range.minimum < range.maximum;
}

export function resolveAntennaColorRange(data: AntennaColorRange, manual?: AntennaColorRange): AntennaColorRange {
  if (manual && !validAntennaColorRange(manual)) throw new Error("Invalid antenna color range.");
  return manual ?? data;
}

/** Scale before subtracting to avoid overflow for opposite finite endpoints. */
export function antennaColorCoordinate(value: number, range: AntennaColorRange): number {
  if (value <= range.minimum && range.minimum < range.maximum) return 0;
  if (value >= range.maximum && range.minimum < range.maximum) return 1;
  const scale = Math.max(Math.abs(range.minimum), Math.abs(range.maximum)) || 1;
  const span = range.maximum / scale - range.minimum / scale;
  return span > 0 ? Math.max(0, Math.min(1, (value / scale - range.minimum / scale) / span)) : 0.5;
}

/** Reject a range the vector shader cannot represent instead of silently changing its limits. */
export function antennaSurfaceColorRange(range: AntennaColorRange, vectorScale: number): AntennaColorRange {
  const minimum = Math.fround(range.minimum / vectorScale), maximum = Math.fround(range.maximum / vectorScale);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !Number.isFinite(Math.fround(maximum - minimum)) ||
      range.minimum < range.maximum && minimum >= maximum) {
    throw new Error("Color limits exceed the precision of this surface carrier. Choose a wider representable range or reset to Auto.");
  }
  return { minimum, maximum };
}
