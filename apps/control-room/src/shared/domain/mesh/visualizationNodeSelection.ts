export interface VisualizationNodeSelection {
  nodeCount?: number;
  node_count?: number;
  nodeIndices?: readonly number[];
  node_indices?: readonly number[];
  nodeStart?: number;
  node_start?: number;
}

export function buildAirOnlyVisualizationNodeSelection({
  airSelection,
  magneticSelections,
  nodeCount,
  surfaceFaces,
}: {
  airSelection: VisualizationNodeSelection;
  magneticSelections: readonly VisualizationNodeSelection[];
  nodeCount: number;
  surfaceFaces?: readonly (readonly number[])[] | null;
}): VisualizationNodeSelection {
  const magneticNodes = new Set<number>();
  for (const selection of magneticSelections) {
    for (const nodeIndex of visualizationNodeSelectionIndices(
      selection,
      nodeCount,
    )) {
      magneticNodes.add(nodeIndex);
    }
  }

  const surfaceNodes = surfaceFaces?.length
    ? new Set(
        surfaceFaces.flatMap((face) =>
          face.filter((nodeIndex) => validNodeIndex(nodeIndex, nodeCount)),
        ),
      )
    : null;
  const nodeIndices = visualizationNodeSelectionIndices(
    airSelection,
    nodeCount,
  ).filter(
    (nodeIndex) =>
      !magneticNodes.has(nodeIndex) &&
      (surfaceNodes === null || surfaceNodes.has(nodeIndex)),
  );

  return { nodeIndices };
}

export function countVisualizationNodeSelection(
  selection: VisualizationNodeSelection | null | undefined,
  nodeCount: number,
): number {
  return visualizationNodeSelectionIndices(selection, nodeCount).length;
}

export function visualizationNodeSelectionIndices(
  selection: VisualizationNodeSelection | null | undefined,
  nodeCount: number,
): number[] {
  const safeNodeCount = Math.max(0, Math.floor(nodeCount));
  const explicit = selection?.nodeIndices ?? selection?.node_indices;
  if (explicit) {
    return [...new Set(explicit.filter((value) => validNodeIndex(value, safeNodeCount)))];
  }

  const start = Math.max(
    0,
    Math.floor(selection?.nodeStart ?? selection?.node_start ?? 0),
  );
  if (start >= safeNodeCount) return [];
  const rawCount = selection?.nodeCount ?? selection?.node_count;
  const count = Math.min(
    rawCount === undefined
      ? safeNodeCount - start
      : Math.max(0, Math.floor(rawCount)),
    safeNodeCount - start,
  );
  return Array.from({ length: count }, (_, offset) => start + offset);
}

function validNodeIndex(value: number, nodeCount: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < nodeCount;
}
