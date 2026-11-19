import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "./codecs/types";
import { projectTensorField, type TensorFieldDescriptor } from "./tensorFieldProjection";

const descriptor: TensorFieldDescriptor = {
  axes: ["flow", "spin"],
  component_labels: ["xx", "xy", "xz", "yx", "yy", "yz", "zx", "zy", "zz"],
  layout: "flow_major",
  rank: 2,
  shape: [3, 3],
};

function field(values: Float32Array | Float64Array): DecodedFieldVector {
  const common = {
    domainGenerationId: "domain-1",
    formatVersion: 5 as const,
    grid: [1, 1, 1] as [number, number, number],
    indexing: "full_domain" as const,
    meshTopologyHash: "mesh-1",
    meshTopologyRevision: "7",
    nComp: 9,
    pointCount: 1,
    quantityId: "tensor:flow-spin",
    scopeId: null,
    scopeKind: "full" as const,
    valueCount: 9,
  };
  return values instanceof Float32Array
    ? { ...common, dtype: "float32", values }
    : { ...common, dtype: "float64", values };
}

describe("projectTensorField", () => {
  it.each([
    ["float32", new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ["float64", new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
  ] as const)("preserves %s value storage for display projections", (dtype, values) => {
    const projected = projectTensorField(field(values), descriptor, "c4");

    expect(projected.dtype).toBe(dtype);
    expect(projected.values).toBeInstanceOf(
      dtype === "float32" ? Float32Array : Float64Array,
    );
    expect(Array.from(projected.values)).toEqual([5]);
    expect(projected.projectionToken).toBe("c4");
  });
});
