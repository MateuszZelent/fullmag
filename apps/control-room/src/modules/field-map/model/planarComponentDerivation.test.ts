import { describe, expect, it } from "vitest";

import {
  derivePlanarComponentScalar,
  isClientDerivablePlanarComponent,
  resolvePlanarComponentDerivation,
} from "./planarComponentDerivation";

const vector = { components: 3, shape: "vector_field", tensor: null };

describe("client-side planar components", () => {
  it("derives x/y/z/magnitude only for plane samples of three-component non-tensor quantities", () => {
    expect(resolvePlanarComponentDerivation({ component: "x", operatorKind: "plane_sample", quantity: vector })).toBe("client");
    expect(resolvePlanarComponentDerivation({ component: "magnitude", operatorKind: "plane_sample", quantity: vector })).toBe("client");
    expect(resolvePlanarComponentDerivation({ component: "x", operatorKind: "slab_average", quantity: vector })).toBe("backend");
    expect(resolvePlanarComponentDerivation({ component: "normal", operatorKind: "plane_sample", quantity: vector })).toBe("backend");
    expect(resolvePlanarComponentDerivation({ component: "x", operatorKind: "plane_sample", quantity: { components: 1 } })).toBe("backend");
    expect(resolvePlanarComponentDerivation({ component: "x", operatorKind: "plane_sample", quantity: { components: 3, tensor: {} } })).toBe("backend");
    expect(resolvePlanarComponentDerivation({ component: "x", operatorKind: "plane_sample", quantity: null })).toBe("backend");
    expect(isClientDerivablePlanarComponent("u")).toBe(false);
  });

  it("matches the backend component of a sampled vector, keeping empty pixels empty", () => {
    const vectors = [3, 4, 12, Number.NaN, Number.NaN, Number.NaN];
    expect(Array.from(derivePlanarComponentScalar(vectors, "x"))).toEqual([3, Number.NaN]);
    expect(Array.from(derivePlanarComponentScalar(vectors, "z"))).toEqual([12, Number.NaN]);
    expect(Array.from(derivePlanarComponentScalar(vectors, "magnitude"))).toEqual([13, Number.NaN]);
  });
});
