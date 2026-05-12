import { describe, expect, it } from "vitest";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import { buildFdmCuboidInstanceModel } from "./FdmCuboidLayer";

function domainFixture(
  overrides: Partial<FdmGridRenderDomain> = {},
): FdmGridRenderDomain {
  return {
    bounds: {
      center: [2e-9, 2e-9, 1.5e-9],
      radius: 3e-9,
      size: [4e-9, 4e-9, 3e-9],
    },
    displayCellBudget: 4,
    displayCellCount: 4,
    kind: "fdm-grid",
    origin: [0, 0, 0],
    shape: [4, 2, 1],
    spacing: [1e-9, 2e-9, 3e-9],
    stride: 2,
    totalCells: 8,
    ...overrides,
  };
}

describe("FdmCuboidLayer model", () => {
  it("samples FDM cells from grid shape, origin and spacing", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());

    expect(model?.count).toBe(4);
    expect(model?.cellSize[0]).toBeCloseTo(0.92e-9);
    expect(model?.cellSize[1]).toBeCloseTo(1.84e-9);
    expect(model?.cellSize[2]).toBeCloseTo(2.76e-9);
    expect(Array.from(model?.centers ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
    ]);
  });

  it("returns no model when the FDM display budget resolves to zero cells", () => {
    expect(
      buildFdmCuboidInstanceModel(
        domainFixture({ displayCellCount: 0, totalCells: 0 }),
      ),
    ).toBeNull();
  });
});
