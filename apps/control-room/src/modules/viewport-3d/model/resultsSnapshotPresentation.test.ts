import { describe, expect, it } from "vitest";

import type { SnapshotVisualizationAppearance } from "@/kernel/visualization/SnapshotVisualizationController";

import {
  presentResultsSnapshot,
  resultsSnapshotGeometryKey,
  type ResultsSnapshotPresentationInput,
} from "./resultsSnapshotPresentation";

const appearance: SnapshotVisualizationAppearance = {
  component: "x",
  palette: "coolwarm",
  visible: true,
  rangeMode: "auto",
  min: null,
  max: null,
};

function input(
  values: number[],
  overrides: Partial<ResultsSnapshotPresentationInput> = {},
): ResultsSnapshotPresentationInput {
  return {
    values: new Float64Array(values),
    componentCount: 3,
    fieldLayout: "aos_node_major",
    nodeCount: 2,
    sampleShape: [2, 3],
    appearance,
    ...overrides,
  };
}

describe("resultsSnapshotPresentation", () => {
  it("projects AoS node-major components in canonical scalar order", () => {
    const result = presentResultsSnapshot(input([1, 2, 3, 4, 5, 6]));

    expect(result.error).toBeNull();
    expect(Array.from(result.presentation!.scalarValues)).toEqual([1, 4]);
    expect(result.presentation!.range).toEqual({ min: 1, max: 4 });
    expect(result.presentation!.colors).toHaveLength(6);
  });

  it("normalizes SoA component-major data before selecting z and magnitude", () => {
    const z = presentResultsSnapshot(input([1, 4, 2, 5, 3, 6], {
      fieldLayout: "soa_component_major",
      appearance: { ...appearance, component: "z" },
    }));
    const magnitude = presentResultsSnapshot(input([1, 4, 2, 5, 3, 6], {
      fieldLayout: "soa_component_major",
      appearance: { ...appearance, component: "magnitude" },
    }));

    expect(Array.from(z.presentation!.scalarValues)).toEqual([3, 6]);
    expect(magnitude.presentation!.scalarValues[0]).toBeCloseTo(Math.sqrt(14), 14);
    expect(magnitude.presentation!.scalarValues[1]).toBeCloseTo(Math.sqrt(77), 14);
  });

  it("keeps scalar payloads scalar and applies symmetric/manual ranges", () => {
    const symmetric = presentResultsSnapshot(input([-2, 4], {
      componentCount: 1,
      fieldLayout: null,
      nodeCount: 2,
      sampleShape: [2],
      appearance: { ...appearance, component: "magnitude", rangeMode: "symmetric" },
    }));
    const manual = presentResultsSnapshot(input([-2, 4], {
      componentCount: 1,
      fieldLayout: null,
      nodeCount: 2,
      sampleShape: [2],
      appearance: { ...appearance, rangeMode: "manual", min: -10, max: 10 },
    }));
    const fixedSymmetric = presentResultsSnapshot(input([-2, 4], {
      componentCount: 1,
      fieldLayout: null,
      nodeCount: 2,
      sampleShape: [2],
      appearance: { ...appearance, rangeMode: "symmetric", min: -2, max: 2 },
    }));

    expect(Array.from(symmetric.presentation!.scalarValues)).toEqual([-2, 4]);
    expect(symmetric.presentation!.range).toEqual({ min: -4, max: 4 });
    expect(manual.presentation!.range).toEqual({ min: -10, max: 10 });
    expect(fixedSymmetric.presentation!.range).toEqual({ min: -2, max: 2 });
  });

  it("uses active-node support for automatic range and hides only the field", () => {
    const result = presentResultsSnapshot(input([1, 2, 3, 4, 5, 6, 100, 100, 100], {
      activeNodes: new Uint8Array([1, 1, 0]),
      nodeCount: 3,
      sampleShape: [3, 3],
      appearance: { ...appearance, visible: false },
    }));

    expect(result.error).toBeNull();
    expect(result.presentation!.range).toEqual({ min: 1, max: 4 });
    expect(result.presentation!.colors).toBeNull();
  });

  it("rejects shape, layout, non-finite, and invalid range contracts", () => {
    expect(presentResultsSnapshot(input([1, 2, 3, 4, 5, 6], { sampleShape: [2, 2] })).error)
      .toContain("shape");
    expect(presentResultsSnapshot(input([1, 2, 3, 4, 5, 6], { fieldLayout: "ambiguous" })).error)
      .toContain("explicit AoS or SoA");
    expect(presentResultsSnapshot(input([1, Number.NaN, 3, 4, 5, 6])).error)
      .toContain("non-finite");
    expect(presentResultsSnapshot(input([1, 2, 3, 4, 5, 6], {
      appearance: { ...appearance, rangeMode: "manual", min: 4, max: 4 },
    })).error).toContain("minimum < maximum");
  });

  it("keeps geometry identity stable for equivalent FDM bounds and revision-pins FEM", () => {
    const fdm = {
      kind: "fdm" as const,
      cells_xyz: [2, 3, 1] as [number, number, number],
      cell_size_m: [1, 2, 3] as [number, number, number],
      origin_m: [0, 0, 0] as [number, number, number],
    };
    const fem = { kind: "fem_p1" as const, node_count: 4, cell_count: 2 };

    expect(resultsSnapshotGeometryKey(fdm, "revision-1")).toBe(
      resultsSnapshotGeometryKey({ ...fdm }, "revision-1"),
    );
    expect(resultsSnapshotGeometryKey(fdm, "revision-1")).toBe(
      resultsSnapshotGeometryKey(fdm, "revision-2"),
    );
    expect(resultsSnapshotGeometryKey({ ...fdm, origin_m: [1, 0, 0] as [number, number, number] }, "revision-1"))
      .not.toBe(resultsSnapshotGeometryKey(fdm, "revision-1"));
    expect(resultsSnapshotGeometryKey(fem, "revision-1")).not.toBe(
      resultsSnapshotGeometryKey(fem, "revision-2"),
    );
  });
});
