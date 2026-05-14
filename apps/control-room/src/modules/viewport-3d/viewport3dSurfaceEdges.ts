import { BufferAttribute, BufferGeometry } from "three";

export function buildSurfaceEdgeIndices(
  surfaceIndices: ArrayLike<number> | null | undefined,
): Uint32Array | null {
  if (!surfaceIndices || surfaceIndices.length < 3 || surfaceIndices.length % 3 !== 0) {
    return null;
  }

  const seen = new Set<number>();
  const edges: number[] = [];

  for (let index = 0; index < surfaceIndices.length; index += 3) {
    const a = surfaceIndices[index];
    const b = surfaceIndices[index + 1];
    const c = surfaceIndices[index + 2];
    if (!isValidIndex(a) || !isValidIndex(b) || !isValidIndex(c)) {
      return null;
    }
    appendEdge(edges, seen, a, b);
    appendEdge(edges, seen, b, c);
    appendEdge(edges, seen, c, a);
  }

  return edges.length > 0 ? new Uint32Array(edges) : null;
}

export function buildSurfaceEdgeGeometry(
  positions: Float32Array,
  surfaceIndices: ArrayLike<number> | null | undefined,
): BufferGeometry | null {
  const edgeIndices = buildSurfaceEdgeIndices(surfaceIndices);
  if (!edgeIndices) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(edgeIndices, 1));
  return geometry;
}

export function buildLineIndexGeometry(
  positions: Float32Array,
  lineIndices: ArrayLike<number> | null | undefined,
): BufferGeometry | null {
  if (!lineIndices || lineIndices.length < 2 || lineIndices.length % 2 !== 0) {
    return null;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(lineIndices), 1));
  return geometry;
}

export function buildSurfaceEdgeGeometryFromBufferGeometry(
  source: BufferGeometry,
): BufferGeometry | null {
  const position = source.getAttribute("position");
  if (!(position instanceof BufferAttribute) || position.itemSize !== 3) {
    return null;
  }

  const sourceIndex = source.getIndex();
  const surfaceIndices = sourceIndex?.array ?? sequentialIndices(position.count);
  const edgeIndices = buildSurfaceEdgeIndices(surfaceIndices);
  if (!edgeIndices) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", position.clone());
  geometry.setIndex(new BufferAttribute(edgeIndices, 1));
  return geometry;
}

/**
 * Szudzik pairing function — maps two non-negative integers to a unique
 * non-negative integer.  Collision-free for indices < 2^23 (~8M vertices).
 * Used instead of string keys to eliminate per-edge string allocation and
 * GC pressure on large meshes.
 */
function szudzikPair(a: number, b: number): number {
  return a >= b ? a * a + a + b : b * b + a;
}

function appendEdge(
  edges: number[],
  seen: Set<number>,
  first: number,
  second: number,
): void {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = szudzikPair(a, b);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a, b);
}

function isValidIndex(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function sequentialIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    indices[index] = index;
  }
  return indices;
}
