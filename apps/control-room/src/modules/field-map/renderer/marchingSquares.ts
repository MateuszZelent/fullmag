export type ContourSegment = readonly [number, number, number, number];

const CASE_EDGES: Readonly<Record<number, readonly [number, number][]>> = {
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  5: [[3, 2], [0, 1]],
  6: [[0, 2]],
  7: [[3, 2]],
  8: [[2, 3]],
  9: [[0, 2]],
  10: [[0, 3], [1, 2]],
  11: [[1, 2]],
  12: [[1, 3]],
  13: [[0, 1]],
  14: [[3, 0]],
};

export function marchingSquares(
  values: ArrayLike<number>,
  width: number,
  height: number,
  level: number,
  mask?: ArrayLike<number>,
): ContourSegment[] {
  const segments: ContourSegment[] = [];
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const indices = [
        y * width + x,
        y * width + x + 1,
        (y + 1) * width + x + 1,
        (y + 1) * width + x,
      ];
      if (indices.some((index) => mask?.[index])) continue;
      const cell = indices.map((index) => values[index] ?? Number.NaN);
      if (cell.some((value) => !Number.isFinite(value))) continue;
      const code = cell.reduce(
        (result, value, index) =>
          result | (value >= level ? 1 << index : 0),
        0,
      );
      for (const [a, b] of CASE_EDGES[code] ?? []) {
        const start = edgePoint(a, x, y, cell, level);
        const end = edgePoint(b, x, y, cell, level);
        segments.push([start[0], start[1], end[0], end[1]]);
      }
    }
  }
  return segments;
}

function edgePoint(
  edge: number,
  x: number,
  y: number,
  values: number[],
  level: number,
): [number, number] {
  const corners = [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
  ];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const [a, b] = pairs[edge]!;
  const span = values[b]! - values[a]!;
  const t = span === 0 ? 0.5 : (level - values[a]!) / span;
  return [
    corners[a]![0]! + t * (corners[b]![0]! - corners[a]![0]!),
    corners[a]![1]! + t * (corners[b]![1]! - corners[a]![1]!),
  ];
}
