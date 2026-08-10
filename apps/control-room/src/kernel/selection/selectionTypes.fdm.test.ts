import { describe, expect, it } from "vitest";

import { selectionRefEquals, type SelectionRef } from "./selectionTypes";

function fdmCell(overrides: Partial<Extract<SelectionRef, { type: "fdm-cell" }>> = {}): Extract<SelectionRef, { type: "fdm-cell" }> {
  return {
    cellOrdinal: "7",
    gridFingerprint: "grid-7",
    ijk: [1, 1, 0],
    kind: "fdm.cell",
    maskState: "region",
    membershipRevision: "11:12",
    nodeId: "model:mesh:grid",
    numericRegionId: 7,
    regionId: "region:core",
    type: "fdm-cell",
    visualizationTargetId: "fdm-domain",
    ...overrides,
  };
}

describe("FDM cell selection identity", () => {
  it("compares every stable grid and membership field", () => {
    const base = fdmCell();
    expect(selectionRefEquals(base, fdmCell())).toBe(true);
    for (const change of [
      { cellOrdinal: "8" },
      { ijk: [0, 1, 0] as const },
      { maskState: "active-unassigned" as const },
      { numericRegionId: null, regionId: null },
      { gridFingerprint: "other" },
      { membershipRevision: "11:13" },
    ]) {
      expect(selectionRefEquals(base, fdmCell(change))).toBe(false);
    }
  });

  it("keeps grid-node selections in the canonical FDM domain namespace", () => {
    const base: Extract<SelectionRef, { type: "fdm-domain" }> = {
      kind: "mesh.grid.mask",
      nodeId: "model:mesh:mask",
      scope: "mask",
      type: "fdm-domain",
      visualizationTargetId: "fdm-domain",
    };
    expect(selectionRefEquals(base, { ...base })).toBe(true);
    expect(
      selectionRefEquals(base, {
        ...base,
        nodeId: "model:mesh:provenance",
      }),
    ).toBe(false);
  });

  it("includes the semantic FDM scope and region in equality", () => {
    const region: Extract<SelectionRef, { type: "fdm-domain" }> = {
      kind: "mesh.grid.region",
      nodeId: "model:mesh:region:core",
      regionId: "region:core",
      scope: "region",
      type: "fdm-domain",
      visualizationTargetId: "fdm-domain",
    };
    expect(selectionRefEquals(region, { ...region })).toBe(true);
    expect(selectionRefEquals(region, { ...region, regionId: "region:shell" })).toBe(false);
    expect(
      selectionRefEquals(region, {
        ...region,
        scope: "magnetic-support",
      }),
    ).toBe(false);
  });

  it("keeps duplicate region ids distinct by ferromagnetic owner", () => {
    const first: Extract<SelectionRef, { type: "fdm-domain" }> = {
      kind: "mesh.grid.region",
      nodeId: "model:mesh:region:object%3Aa:shared",
      objectId: "object:a",
      regionId: "shared",
      scope: "region",
      type: "fdm-domain",
      visualizationTargetId: "fdm-domain",
    };
    const second = {
      ...first,
      objectId: "object:b",
    };

    expect(selectionRefEquals(first, first)).toBe(true);
    expect(selectionRefEquals(first, second)).toBe(false);
    expect(selectionRefEquals(first, { ...first, objectId: undefined })).toBe(false);
  });
});
