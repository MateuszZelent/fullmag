import { describe, expect, it } from "vitest";

import { smartAutoScale } from "../femSliceColorScale";

describe("smartAutoScale", () => {
  it("locks magnetization world components to [-1, 1]", () => {
    expect(smartAutoScale(-0.12, 0.34, "m", "x")).toEqual({
      min: -1,
      max: 1,
      mode: "diverging",
    });
    expect(smartAutoScale(0.01, 0.99, "m", "z")).toEqual({
      min: -1,
      max: 1,
      mode: "diverging",
    });
  });

  it("symmetrizes signed fields around zero", () => {
    expect(smartAutoScale(-2, 5, "H_demag", "magnitude")).toEqual({
      min: -5,
      max: 5,
      mode: "diverging",
    });
  });

  it("keeps one-sided fields sequential", () => {
    expect(smartAutoScale(1, 5, "H_demag", "magnitude")).toEqual({
      min: 1,
      max: 5,
      mode: "positive",
    });
    expect(smartAutoScale(-5, -1, "H_demag", "magnitude")).toEqual({
      min: -5,
      max: -1,
      mode: "negative",
    });
  });
});
