import { describe, it, expect } from "vitest";
import { FemDomainAdapter } from "../FemDomainAdapter";
import type { DomainMeta } from "../../../api/types";
import type { DecodedTopology } from "../../../api/codecs/types";

function makeFemMeta(overrides?: Partial<DomainMeta>): DomainMeta {
  return {
    discretization: "fem",
    dimension: 3,
    generation_id: 2,
    bounds: {
      min: [0, 0, 0],
      max: [1, 1, 1],
    },
    counts: {
      point_count: 4,
      cell_count: 1,
      element_count: 1,
      boundary_face_count: 4,
    },
    structured_grid: null,
    ...overrides,
  };
}

function makeTopology(): DecodedTopology {
  return {
    nodeCount: 4,
    elementCount: 1,
    boundaryFaceCount: 4,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 3]),
    boundaryFaces: new Uint32Array([
      0, 1, 2,
      0, 1, 3,
      0, 2, 3,
      1, 2, 3,
    ]),
    elementMarkers: new Uint32Array([1]),
    boundaryMarkers: new Uint32Array([1, 1, 1, 1]),
  };
}

describe("FemDomainAdapter", () => {
  it("constructs with fem DomainMeta and topology", () => {
    const adapter = new FemDomainAdapter(makeFemMeta(), makeTopology());
    expect(adapter.kind).toBe("fem");
    expect(adapter.generationId).toBe(2);
    expect(adapter.pointCount).toBe(4);
  });

  it("throws for non-fem domain", () => {
    expect(
      () =>
        new FemDomainAdapter(
          makeFemMeta({ discretization: "fdm" }),
          makeTopology(),
        ),
    ).toThrow(/requires fem/);
  });

  it("getPositions returns Float32Array converted from Float64", () => {
    const adapter = new FemDomainAdapter(makeFemMeta(), makeTopology());
    const positions = adapter.getPositions();
    expect(positions).toBeInstanceOf(Float32Array);
    expect(positions.length).toBe(12); // 4 nodes * 3
    expect(positions[0]).toBeCloseTo(0.0);
    expect(positions[3]).toBeCloseTo(1.0);
    expect(positions[7]).toBeCloseTo(1.0);
  });

  it("getPositions returns cached result on second call", () => {
    const adapter = new FemDomainAdapter(makeFemMeta(), makeTopology());
    const first = adapter.getPositions();
    const second = adapter.getPositions();
    expect(first).toBe(second);
  });

  it("getIndices returns boundary face indices", () => {
    const topo = makeTopology();
    const adapter = new FemDomainAdapter(makeFemMeta(), topo);
    const indices = adapter.getIndices();
    expect(indices).toBe(topo.boundaryFaces);
    expect(indices!.length).toBe(12); // 4 faces * 3
  });

  it("getDomainInfo returns correct info", () => {
    const adapter = new FemDomainAdapter(makeFemMeta(), makeTopology());
    const info = adapter.getDomainInfo();
    expect(info.discretization).toBe("fem");
    expect(info.dimension).toBe(3);
    expect(info.pointCount).toBe(4);
    expect(info.elementCount).toBe(1);
    expect(info.gridShape).toBeUndefined();
  });

  it("getBounds returns correct bounds", () => {
    const adapter = new FemDomainAdapter(makeFemMeta(), makeTopology());
    const bounds = adapter.getBounds();
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([1, 1, 1]);
  });

  it("getRenderGeometry includes normals", () => {
    const adapter = new FemDomainAdapter(makeFemMeta(), makeTopology());
    const geom = adapter.getRenderGeometry();
    expect(geom.positions).toBeInstanceOf(Float32Array);
    expect(geom.indices).not.toBeNull();
    expect(geom.normals).not.toBeNull();
    expect(geom.normals!.length).toBe(12);
    expect(geom.cellCount).toBe(1);
    expect(geom.vertexCount).toBe(4);
  });
});
