import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildFdmFieldIndexResolver,
  type FdmFieldIndexingResult,
} from "./fdmFieldIndexing";

function fieldVector(
  pointCount: number,
  indexing?: DecodedFieldVector["indexing"],
  nodeIndices?: readonly number[] | null,
): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    indexing,
    nComp: 3,
    nodeIndices,
    pointCount,
    quantityId: "m",
    valueCount: pointCount * 3,
    values: new Float64Array(pointCount * 3),
  };
}

function expectCompatible(
  result: FdmFieldIndexingResult,
): Extract<FdmFieldIndexingResult, { status: "compatible" }> {
  expect(result.status).toBe("compatible");
  if (result.status !== "compatible") {
    throw new Error("expected compatible FDM field indexing");
  }
  return result;
}

describe("buildFdmFieldIndexResolver", () => {
  it("accepts a complete FDM full-domain payload in direct cell order", () => {
    const resolver = expectCompatible(
      buildFdmFieldIndexResolver(fieldVector(4, "full_domain"), 4),
    );

    expect(resolver.resolve(0)).toBe(0);
    expect(resolver.resolve(3)).toBe(3);
  });

  it("accepts a legacy FMVP v2 payload only when its count proves full-domain order", () => {
    const resolver = expectCompatible(
      buildFdmFieldIndexResolver(fieldVector(4), 4),
    );

    expect(resolver.resolve(2)).toBe(2);
    expect(
      buildFdmFieldIndexResolver(fieldVector(3), 4),
    ).toMatchObject({
      reason: "point-count-mismatch",
      status: "degraded",
    });
  });

  it("rejects an ambiguous scalar XY plane for a multi-layer FDM domain", () => {
    const projectedScalar = {
      ...fieldVector(4, "legacy_count_only"),
      grid: [2, 2, 1] as [number, number, number],
      nComp: 1,
      valueCount: 4,
      values: new Float64Array(4),
    };
    expect(
      buildFdmFieldIndexResolver(projectedScalar, 8, [2, 2, 2]),
    ).toMatchObject({ reason: "point-count-mismatch", status: "degraded" });
  });

  it("does not treat a vector XY plane as a projected scalar field", () => {
    const projectedVector = {
      ...fieldVector(4, "legacy_count_only"),
      grid: [2, 2, 1] as [number, number, number],
    };

    expect(
      buildFdmFieldIndexResolver(projectedVector, 8, [2, 2, 2]),
    ).toMatchObject({ reason: "point-count-mismatch", status: "degraded" });
  });

  it("maps explicit FDM cell indices instead of treating payload order as cell order", () => {
    const resolver = expectCompatible(
      buildFdmFieldIndexResolver(
        fieldVector(2, "explicit_node_indices", [3, 1]),
        4,
      ),
    );

    expect(resolver.resolve(3)).toBe(0);
    expect(resolver.resolve(1)).toBe(1);
    expect(resolver.resolve(0)).toBeNull();
  });

  it("maps sampled FDM cell indices and leaves unsampled cells unresolved", () => {
    const resolver = expectCompatible(
      buildFdmFieldIndexResolver(
        fieldVector(2, "sampled_node_indices", [0, 3]),
        4,
      ),
    );

    expect(resolver.resolve(0)).toBe(0);
    expect(resolver.resolve(3)).toBe(1);
    expect(resolver.resolve(2)).toBeNull();
  });

  it("fails closed for explicit or sampled payloads without a complete node-index list", () => {
    for (const indexing of [
      "explicit_node_indices",
      "sampled_node_indices",
    ] as const) {
      expect(
        buildFdmFieldIndexResolver(fieldVector(2, indexing), 4),
      ).toMatchObject({
        reason: "missing-node-indices",
        status: "degraded",
      });
    }
  });

  it("fails closed for duplicate or out-of-range FDM cell indices", () => {
    expect(
      buildFdmFieldIndexResolver(
        fieldVector(2, "explicit_node_indices", [1, 1]),
        4,
      ),
    ).toMatchObject({ reason: "duplicate-node-index", status: "degraded" });
    expect(
      buildFdmFieldIndexResolver(
        fieldVector(2, "sampled_node_indices", [0, 4]),
        4,
      ),
    ).toMatchObject({ reason: "node-index-out-of-range", status: "degraded" });
  });
});
