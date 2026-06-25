import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildViewport3DTargetFieldBuffer,
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
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldRevision: "field-1",
      fieldVector: vectorFixture(),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
      topologyRevision: "topology-1",
    });

    expect(buffer.capability).toBe("full-vector-complete");
    expect(buffer.complete).toBe(true);
    expect(buffer.sampled).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
  });

  it("allows sampled full vectors for glyphs but not surface shaders", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture(),
      query: {
        component: "full",
        max_samples: 128,
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("full-vector-sampled");
    expect(buffer.complete).toBe(false);
    expect(buffer.sampled).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
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
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
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
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
  });
});
