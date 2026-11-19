import { describe, expect, it } from "vitest";
import { absorbingExpressionError } from "./absorbingExpressionValidation";

describe("absorbing boundary expressions", () => {
  it("accepts normalized scalar ramps with powers, unary signs and math functions", () => {
    for (const source of ["u", "u**3", "-(-u)**3", "log1p(9*u)/log(10)"]) {
      expect(absorbingExpressionError(source, "profile")).toBeUndefined();
    }
  });
  it("rejects out-of-range ramps, wrong endpoints and singular interiors", () => {
    for (const source of ["u+0.01", "u**0", "1/(u-0.5)", "sqrt(u-1)", "2*u"]) {
      expect(absorbingExpressionError(source, "profile")).toBeTruthy();
    }
  });
  it("accepts spatial coordinates and combinations of distances in metres", () => {
    for (const source of ["5e-7-sqrt(x*x+y*y)", "max(x,abs(z))-1e-7", "min(y,3e-8-x)", "(z-1e-7)**2"]) {
      expect(absorbingExpressionError(source, "distance")).toBeUndefined();
    }
  });
  it("rejects malformed expressions and references outside each coordinate system", () => {
    for (const source of ["min(x)", "x-)", "u", "sin(z,x)", "sqrt(1", "1e999", "x;z", "x**", "01+x"]) {
      expect(absorbingExpressionError(source, "distance")).toBeTruthy();
    }
    for (const source of ["z", "u+z", "min(u,u)", "u+"]) {
      expect(absorbingExpressionError(source, "profile")).toBeTruthy();
    }
  });
});
