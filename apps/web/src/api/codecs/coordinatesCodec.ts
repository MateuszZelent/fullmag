/**
 * Binary coordinate codec for `/v1/live/current/domain/coordinates`.
 *
 * The payload is a tightly packed float64 stream: `[x0, y0, z0, x1, y1, z1, ...]`.
 */

export interface DecodedCoordinates {
  pointCount: number;
  positions: Float64Array;
}

export function decodeCoordinates(buffer: ArrayBuffer): DecodedCoordinates {
  if (buffer.byteLength % Float64Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(
      `Coordinate payload size ${buffer.byteLength} is not aligned to float64 values`,
    );
  }

  const positions = new Float64Array(buffer);
  if (positions.length % 3 !== 0) {
    throw new Error(
      `Coordinate payload contains ${positions.length} scalars, expected a multiple of 3`,
    );
  }

  return {
    pointCount: positions.length / 3,
    positions,
  };
}
