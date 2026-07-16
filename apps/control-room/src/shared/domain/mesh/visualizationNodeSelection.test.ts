import { describe, expect, it } from "vitest";

import {
  buildAirOnlyVisualizationNodeSelection,
  countVisualizationNodeSelection,
} from "./visualizationNodeSelection";

describe("buildAirOnlyVisualizationNodeSelection", () => {
  it("subtracts magnetic interface nodes from the full air carrier", () => {
    const selection = buildAirOnlyVisualizationNodeSelection({
      airSelection: { node_indices: [2, 3, 4, 5, 6] },
      magneticSelections: [{ node_indices: [0, 1, 2, 3] }],
      nodeCount: 7,
    });

    expect(selection).toEqual({ nodeIndices: [4, 5, 6] });
    expect(countVisualizationNodeSelection(selection, 7)).toBe(3);
  });

  it("derives the matching air-only surface subset", () => {
    const selection = buildAirOnlyVisualizationNodeSelection({
      airSelection: { node_indices: [2, 3, 4, 5, 6] },
      magneticSelections: [{ node_indices: [0, 1, 2, 3] }],
      nodeCount: 7,
      surfaceFaces: [[2, 4, 5], [3, 5, 6]],
    });

    expect(selection).toEqual({ nodeIndices: [4, 5, 6] });
  });

  it("produces 10,586 nodes for the reference 16,940-node shared carrier", () => {
    const rawAir = Array.from({ length: 16_940 }, (_, index) => index);
    const magnetic = Array.from({ length: 6_354 }, (_, index) => index);

    const selection = buildAirOnlyVisualizationNodeSelection({
      airSelection: { node_indices: rawAir },
      magneticSelections: [{ node_indices: magnetic }],
      nodeCount: 16_940,
    });

    expect(countVisualizationNodeSelection(selection, 16_940)).toBe(10_586);
    expect(selection.nodeIndices?.[0]).toBe(6_354);
  });
});
