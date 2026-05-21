import { describe, expect, it } from "vitest";

import { clampNumber, sameTuple3, nearTuple3 } from "./viewport3dMath";

describe("viewport3dMath", () => {
  it("shares common tuple and clamp helpers across viewport camera code", () => {
    expect(clampNumber(5, 1, 3)).toBe(3);
    expect(clampNumber(-1, 1, 3)).toBe(1);
    expect(sameTuple3([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameTuple3([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(nearTuple3([1, 2, 3], [1, 2 + 1e-8, 3], 1e-7)).toBe(true);
  });
});
