import { describe, it, expect } from "vitest";
import { FdmDomainAdapter } from "../FdmDomainAdapter";
import type { DomainMeta } from "../../../api/types";

function makeFdmMeta(overrides?: Partial<DomainMeta>): DomainMeta {
  return {
    domain_id: "current",
    discretization: "fdm",
    coordinate_system: "cartesian",
    units: { length: "m" },
    dimension: 3,
    generation_id: 1,
    bounds: {
      min: [0, 0, 0],
      max: [2e-7, 2e-7, 1e-7],
    },
    counts: {
      cells: 8,
    },
    grid: {
      shape: [2, 2, 2],
      origin: [0, 0, 0],
      spacing: [1e-7, 1e-7, 0.5e-7],
    },
    element_type: null,
    ...overrides,
  };
}

describe("FdmDomainAdapter", () => {
  it("constructs with fdm DomainMeta", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    expect(adapter.kind).toBe("fdm");
    expect(adapter.generationId).toBe(1);
    expect(adapter.pointCount).toBe(8);
  });

  it("throws for non-fdm domain", () => {
    expect(
      () => new FdmDomainAdapter(makeFdmMeta({ discretization: "fem" })),
    ).toThrow(/requires fdm/);
  });

  it("getPositions returns Float32Array of cell centers", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    const positions = adapter.getPositions();

    expect(positions).toBeInstanceOf(Float32Array);
    // 2*2*2 = 8 cells, 3 components each → 24 floats
    expect(positions.length).toBe(24);

    // First cell center: origin + (0+0.5)*spacing
    const dx = 1e-7;
    const dy = 1e-7;
    const dz = 0.5e-7;
    expect(positions[0]).toBeCloseTo(0.5 * dx, 12);
    expect(positions[1]).toBeCloseTo(0.5 * dy, 12);
    expect(positions[2]).toBeCloseTo(0.5 * dz, 12);
  });

  it("getPositions returns cached result on second call", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    const first = adapter.getPositions();
    const second = adapter.getPositions();
    expect(first).toBe(second); // same reference
  });

  it("getIndices returns null (no explicit topology)", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    expect(adapter.getIndices()).toBeNull();
  });

  it("getDomainInfo returns correct info", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    const info = adapter.getDomainInfo();
    expect(info.discretization).toBe("fdm");
    expect(info.dimension).toBe(3);
    expect(info.pointCount).toBe(8);
    expect(info.cellCount).toBe(8);
    expect(info.gridShape).toEqual([2, 2, 2]);
  });

  it("getBounds returns correct bounds", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    const bounds = adapter.getBounds();
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([2e-7, 2e-7, 1e-7]);
  });

  it("getRenderGeometry has positions and null indices", () => {
    const adapter = new FdmDomainAdapter(makeFdmMeta());
    const geom = adapter.getRenderGeometry();
    expect(geom.positions).toBeInstanceOf(Float32Array);
    expect(geom.indices).toBeNull();
    expect(geom.normals).toBeNull();
    expect(geom.cellCount).toBe(8);
    expect(geom.vertexCount).toBe(8);
  });

  it("throws when structured_grid is missing", () => {
    const adapter = new FdmDomainAdapter(
      makeFdmMeta({ grid: null }),
    );
    expect(() => adapter.getPositions()).toThrow(/missing grid/);
  });
});
