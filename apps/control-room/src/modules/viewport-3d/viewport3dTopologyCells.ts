import type { DecodedTopology } from "@/kernel/api/codecs";

/**
 * Cell connectivity shared by topology index builds: local face and edge
 * tables per cell type and allocation-free iteration over CSR cells.
 */

export type Viewport3DTopologyCells = Pick<
  DecodedTopology,
  | "cellNodes"
  | "cellGlobalOrdinals"
  | "cellOffsets"
  | "cellTypes"
  | "indices"
  | "nodeCount"
>;

export const CELL_FACES: Readonly<Record<number, readonly (readonly number[])[]>> = {
  1: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
  2: [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
  3: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
  4: [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ],
};

export const CELL_EDGES: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
  2: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]],
  3: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]],
  4: [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6],
    [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
  ],
};

/** Cell connectivity as CSR, whether stored mixed or as legacy Tet4 indices. */
export interface TopologyCellCsr {
  count: number;
  nodes: Uint32Array;
  offsets: Uint32Array | null;
  types: Uint32Array | null;
}

export function topologyCellCsr(topology: Viewport3DTopologyCells): TopologyCellCsr {
  if (
    topology.cellTypes &&
    topology.cellOffsets &&
    topology.cellNodes &&
    topology.cellOffsets.length === topology.cellTypes.length + 1
  ) {
    return {
      count: topology.cellTypes.length,
      nodes: topology.cellNodes,
      offsets: topology.cellOffsets,
      types: topology.cellTypes,
    };
  }
  return {
    count: Math.floor(topology.indices.length / 4),
    nodes: topology.indices,
    offsets: null,
    types: null,
  };
}

export function cellStart(cells: TopologyCellCsr, cell: number): number {
  return cells.offsets ? cells.offsets[cell] ?? 0 : cell * 4;
}

export function cellEnd(cells: TopologyCellCsr, cell: number): number {
  return cells.offsets
    ? cells.offsets[cell + 1] ?? cellStart(cells, cell)
    : cell * 4 + 4;
}

export function cellType(cells: TopologyCellCsr, cell: number): number {
  return cells.types ? cells.types[cell] ?? 0 : 1;
}

export function countCellFaces(cells: TopologyCellCsr): number {
  let total = 0;
  for (let cell = 0; cell < cells.count; cell += 1) {
    total += CELL_FACES[cellType(cells, cell)]?.length ?? 0;
  }
  return total;
}

/**
 * Visit every complete in-range face of every (selected) cell without
 * allocating; a triangle reports `n3` as undefined.
 */
export function forEachCellFace(
  cells: TopologyCellCsr,
  nodeCount: number,
  visit: (
    cell: number,
    localFace: number,
    n0: number,
    n1: number,
    n2: number,
    n3: number | undefined,
  ) => void,
  selectedElements: ReadonlySet<number> | null = null,
): void {
  for (let cell = 0; cell < cells.count; cell += 1) {
    if (selectedElements && !selectedElements.has(cell)) continue;
    const start = cellStart(cells, cell);
    const end = cellEnd(cells, cell);
    const localFaces = CELL_FACES[cellType(cells, cell)] ?? [];
    for (let localFace = 0; localFace < localFaces.length; localFace += 1) {
      const corners = localFaces[localFace] ?? [];
      let complete = true;
      for (const corner of corners) {
        const node = start + corner < end ? cells.nodes[start + corner] : undefined;
        if (node === undefined || node >= nodeCount) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      visit(
        cell,
        localFace,
        cells.nodes[start + (corners[0] ?? 0)] ?? 0,
        cells.nodes[start + (corners[1] ?? 0)] ?? 0,
        cells.nodes[start + (corners[2] ?? 0)] ?? 0,
        corners.length > 3 ? cells.nodes[start + (corners[3] ?? 0)] : undefined,
      );
    }
  }
}
