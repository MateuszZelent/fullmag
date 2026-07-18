import { describe, expect, it } from "vitest";

import { marchingSquares } from "./marchingSquares";

describe("marching squares", () => {
  it("produces the golden diagonal crossing for one active corner", () => {
    expect(marchingSquares([1, 0, 0, 0], 2, 2, 0.5)).toEqual([
      [0, 0.5, 0.5, 0],
    ]);
  });

  it("does not draw contours through masked holes", () => {
    expect(
      marchingSquares([1, 0, 0, 0], 2, 2, 0.5, [0, 0, 1, 0]),
    ).toEqual([]);
  });

  it("draws through explicitly renderable overlap-ambiguous support", () => {
    expect(
      marchingSquares([1, 0, 0, 0], 2, 2, 0.5, [4, 4, 4, 4]),
    ).toEqual([[0, 0.5, 0.5, 0]]);
  });
});
