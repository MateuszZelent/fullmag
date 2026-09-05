import { describe, expect, it } from "vitest";

import { marchingSquares, marchingSquaresLevels } from "./marchingSquares";

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

  it("resolves saddle ambiguous case 5 with bilinear asymptotic decider", () => {
    // In row-major (y=0: [0, 1], y=1: [2, 3]):
    // cell corners are (0,0)->index 0, (1,0)->index 1, (1,1)->index 3, (0,1)->index 2.
    // For case 5 (corners 0 and 2 high): values[0]=1, values[3]=1, values[1]=0, values[2]=0.
    const values = [1, 0, 0, 1];
    const highConnect = marchingSquares(values, 2, 2, 0.4);
    const lowConnect = marchingSquares(values, 2, 2, 0.6);

    expect(highConnect).toHaveLength(2);
    expect(lowConnect).toHaveLength(2);
    expect(highConnect).not.toEqual(lowConnect);
  });

  it("resolves saddle ambiguous case 10 with bilinear asymptotic decider", () => {
    // For case 10 (corners 1 and 3 high): values[1]=1, values[2]=1, values[0]=0, values[3]=0.
    const values = [0, 1, 1, 0];
    const highConnect = marchingSquares(values, 2, 2, 0.4);
    const lowConnect = marchingSquares(values, 2, 2, 0.6);

    expect(highConnect).toHaveLength(2);
    expect(lowConnect).toHaveLength(2);
    expect(highConnect).not.toEqual(lowConnect);
  });

  it("extracts multiple contour levels via marchingSquaresLevels", () => {
    // Gradient: [0, 1, 2, 3] in 2x2
    const values = [0, 1, 3, 2];
    const levels = [0.5, 1.5, 2.5];
    const segments = marchingSquaresLevels(values, 2, 2, levels);
    expect(segments.length).toBeGreaterThanOrEqual(3);
  });
});
