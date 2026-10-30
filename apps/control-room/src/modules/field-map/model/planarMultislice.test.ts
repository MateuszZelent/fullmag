import { describe, expect, it } from "vitest";

import { evenMultisliceFractions, resolveMultisliceRange } from "./planarMultislice";

describe("resolveMultisliceRange", () => {
  const extents = [{ max: 0.4, min: -0.2 }, { max: 0.9, min: 0.1 }, { max: 0.3, min: -0.7 }];

  it("takes the union of panel extrema in auto mode", () => {
    expect(resolveMultisliceRange({ mode: "auto" }, extents)).toEqual({ max: 0.9, min: -0.7 });
  });

  it("uses the largest magnitude over all panels in symmetric mode", () => {
    expect(resolveMultisliceRange({ mode: "symmetric" }, extents)).toEqual({ max: 0.9, min: -0.9 });
  });

  it("applies a manual range unchanged and waits for every panel otherwise", () => {
    expect(resolveMultisliceRange({ max: 2, min: -1, mode: "manual" }, [null])).toEqual({ max: 2, min: -1 });
    expect(resolveMultisliceRange({ mode: "auto" }, [extents[0]!, null])).toBeNull();
    expect(resolveMultisliceRange(null, extents)).toBeNull();
  });
});

describe("evenMultisliceFractions", () => {
  it("spaces 2 to 4 panels inside the domain", () => {
    expect(evenMultisliceFractions(3)).toEqual([0.25, 0.5, 0.75]);
    expect(evenMultisliceFractions(9)).toHaveLength(4);
    expect(evenMultisliceFractions(1)).toEqual([1 / 3, 2 / 3]);
  });
});
