import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildViewport3DTargetFieldBuffer,
  resolveViewport3DTargetFieldInput,
  viewport3DTargetFieldBufferCanServeSurface,
  viewport3DTargetFieldBufferCanServeVectors,
} from "./viewport3DTargetFieldBuffer";

function vectorFixture(overrides: Partial<DecodedFieldVector> = {}): DecodedFieldVector {
  const nComp = overrides.nComp ?? 3;
  const pointCount = overrides.pointCount ?? 4;
  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    nComp,
    pointCount,
    quantityId: "m",
    valueCount: pointCount * nComp,
    values: new Float64Array(pointCount * nComp),
    ...overrides,
  };
}

describe("viewport3DTargetFieldBuffer", () => {
  it("classifies unsampled full vectors as complete full-vector buffers", () => {
    const fieldVector = vectorFixture();
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldRevision: "field-1",
      fieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
      topologyRevision: "topology-1",
    });

    expect(buffer.capability).toBe("full-vector-complete");
    expect(buffer.componentCount).toBe(3);
    expect(buffer.complete).toBe(true);
    expect(buffer.requestId).toContain("component=full");
    expect(buffer.requestId).toContain("quantity=m");
    expect(buffer.requestId).toContain("scope_id=part-a");
    expect(buffer.requestId).toContain("scope_kind=part");
    expect(buffer.sampled).toBe(false);
    expect(buffer.values).toBe(fieldVector.values);
    expect(buffer.vectorComponentCount).toBe(buffer.componentCount);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
  });

  it("allows sampled full vectors for glyphs but not surface shaders", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        max_samples: 128,
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("full-vector-sampled");
    expect(buffer.indexing).toBe("sampled_node_indices");
    expect(buffer.meshTopologyHash).toBe("hash-1");
    expect(buffer.nodeIndices).toEqual(new Uint32Array([0, 2, 4, 6]));
    expect(buffer.complete).toBe(false);
    expect(buffer.sampled).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
  });

  it("treats sampled payload metadata as sampled even without max_samples in the query", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("full-vector-sampled");
    expect(buffer.complete).toBe(false);
    expect(buffer.sampled).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
  });

  it("rejects sampled payloads for glyphs when node indices are absent", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
      }),
      query: {
        component: "full",
        max_samples: 128,
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
  });

  it("rejects explicit node-index payloads without topology hash", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "explicit_node_indices",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
  });

  it("accepts explicit node-index payloads with matching map metadata", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "explicit_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
      topologyRevision: "topology-1",
    });

    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(buffer.bufferId).toContain("hash-1");
    expect(buffer.bufferId).toContain("explicit_node_indices");
  });

  it("keeps planner pass consumers on target field buffers", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      consumers: ["part-a:vector-glyph", "part-a:surface"],
      fieldVector: vectorFixture(),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.consumers).toEqual([
      "part-a:surface",
      "part-a:vector-glyph",
    ]);
  });

  it("resolves target buffers before legacy part field vectors", () => {
    const globalFieldVector = vectorFixture({ quantityId: "m" });
    const legacyPartFieldVector = vectorFixture({ quantityId: "H_eff" });
    const targetFieldVector = vectorFixture({ quantityId: "B_demag" });
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: targetFieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        legacyPartFieldVectors: new Map([["part-a", legacyPartFieldVector]]),
        partId: "part-a",
        targetFieldBuffers: new Map([["part-a", targetBuffer]]),
      }),
    ).toEqual({
      explicitFieldBuffer: targetBuffer,
      explicitFieldVector: targetFieldVector,
      fieldVector: targetFieldVector,
      source: "target-buffer",
    });
  });

  it("does not fall back to legacy or global field vectors when target buffers are authoritative", () => {
    const globalFieldVector = vectorFixture({ quantityId: "m" });
    const legacyPartFieldVector = vectorFixture({ quantityId: "H_eff" });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        legacyPartFieldVectors: new Map([["part-a", legacyPartFieldVector]]),
        partId: "part-a",
        targetFieldBuffers: new Map(),
      }),
    ).toEqual({
      explicitFieldBuffer: null,
      explicitFieldVector: null,
      fieldVector: null,
      source: "none",
    });
  });

  it("marks legacy part field vectors as compatibility fallback only", () => {
    const globalFieldVector = vectorFixture({ quantityId: "m" });
    const legacyPartFieldVector = vectorFixture({ quantityId: "H_eff" });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        legacyPartFieldVectors: new Map([["part-a", legacyPartFieldVector]]),
        partId: "part-a",
      }),
    ).toEqual({
      explicitFieldBuffer: null,
      explicitFieldVector: legacyPartFieldVector,
      fieldVector: legacyPartFieldVector,
      source: "legacy-part-field-vector",
    });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        partId: "part-b",
      }),
    ).toEqual({
      explicitFieldBuffer: null,
      explicitFieldVector: null,
      fieldVector: globalFieldVector,
      source: "fallback-field-vector",
    });
  });

  it("allows scalar component buffers for component surfaces but not vectors", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        nComp: 1,
        quantityId: "h_eff",
        valueCount: 4,
        values: new Float64Array(4),
      }),
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("scalar-complete");
    expect(buffer.component).toBe("x");
    expect(buffer.quantityId).toBe("H_eff");
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "y")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "magnitude"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
  });

  it("rejects otherwise compatible buffers from another requested quantity", () => {
    const scalarBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        nComp: 1,
        quantityId: "m",
        valueCount: 4,
        values: new Float64Array(4),
      }),
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });
    const vectorBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({ quantityId: "m" }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(
      viewport3DTargetFieldBufferCanServeSurface(scalarBuffer, "x", "H_eff"),
    ).toBe(false);
    expect(
      viewport3DTargetFieldBufferCanServeSurface(scalarBuffer, "x", "m"),
    ).toBe(true);
    expect(
      viewport3DTargetFieldBufferCanServeVectors(vectorBuffer, "H_eff"),
    ).toBe(false);
    expect(
      viewport3DTargetFieldBufferCanServeVectors(vectorBuffer, "m"),
    ).toBe(true);
  });

  it("treats synthetic airbox payloads as vector-capable render fallbacks", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({ quantityId: "H_eff" }),
      query: {
        component: "full",
        scope_id: "airbox",
        scope_kind: "airbox",
      },
      synthetic: true,
      targetIds: ["airbox"],
    });

    expect(buffer.capability).toBe("synthetic-full-vector");
    expect(buffer.requestId).toBeNull();
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
  });
});
