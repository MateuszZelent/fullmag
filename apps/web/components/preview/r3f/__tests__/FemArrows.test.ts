import { describe, expect, it } from "vitest";
import { resolveFemArrowTemplateScale } from "../FemArrows";

describe("resolveFemArrowTemplateScale", () => {
  it("scales arrow instances from scene extent", () => {
    expect(resolveFemArrowTemplateScale(20)).toBeCloseTo(0.7);
  });

  it("returns zero for invalid or empty extents", () => {
    expect(resolveFemArrowTemplateScale(0)).toBe(0);
    expect(resolveFemArrowTemplateScale(Number.NaN)).toBe(0);
  });
});
