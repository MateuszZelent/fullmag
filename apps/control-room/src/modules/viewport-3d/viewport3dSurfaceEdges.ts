import { BufferAttribute, BufferGeometry } from "three";

export function buildSurfaceEdgeIndices(
  surfaceIndices: ArrayLike<number> | null | undefined,
): Uint32Array | null {
  if (!surfaceIndices || surfaceIndices.length < 3 || surfaceIndices.length % 3 !== 0) {
    return null;
  }

  const seen = new Set<string>();
  const maxEdges = surfaceIndices.length;
  const edges = new Uint32Array(maxEdges * 2);
  let edgeCount = 0;

  for (let index = 0; index < surfaceIndices.length; index += 3) {
    const a = surfaceIndices[index];
    const b = surfaceIndices[index + 1];
    const c = surfaceIndices[index + 2];
    if (!isValidIndex(a) || !isValidIndex(b) || !isValidIndex(c)) {
      return null;
    }

    // Edge A-B
    if (a !== b) {
      const minVal = a < b ? a : b;
      const maxVal = a > b ? a : b;
      const key = edgeKey(minVal, maxVal);
      if (!seen.has(key)) {
        seen.add(key);
        edges[edgeCount++] = minVal;
        edges[edgeCount++] = maxVal;
      }
    }

    // Edge B-C
    if (b !== c) {
      const minVal = b < c ? b : c;
      const maxVal = b > c ? b : c;
      const key = edgeKey(minVal, maxVal);
      if (!seen.has(key)) {
        seen.add(key);
        edges[edgeCount++] = minVal;
        edges[edgeCount++] = maxVal;
      }
    }

    // Edge C-A
    if (c !== a) {
      const minVal = c < a ? c : a;
      const maxVal = c > a ? c : a;
      const key = edgeKey(minVal, maxVal);
      if (!seen.has(key)) {
        seen.add(key);
        edges[edgeCount++] = minVal;
        edges[edgeCount++] = maxVal;
      }
    }
  }

  return edgeCount > 0 ? edges.slice(0, edgeCount) : null;
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



function isValidIndex(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function edgeKey(first: number, second: number): string {
  return `${first}:${second}`;
}

function sequentialIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    indices[index] = index;
  }
  return indices;
}
