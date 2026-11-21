import { describe, expect, it } from "vitest";
import { absorbingExpressionError } from "./absorbingExpressionValidation";

describe("absorbing boundary expressions", () => {
  it("accepts normalized scalar ramps with powers, unary signs and math functions", () => {
    for (const source of ["u", "u**3", "-(-u)**3", "log1p(9*u)/log(10)", "min(2*u, 1)", "sin(pi*u/2)", "atan2(u, 1)/atan2(1, 1)"]) {
      expect(absorbingExpressionError(source, "profile")).toBeUndefined();
    }
  });
  it("accepts finite ramp samples after non-finite intermediate operations", () => {
    for (const source of ["u + 1/exp(999)", "min(u, sqrt(-1))", "max(sqrt(-1), u)", "u * 1**(0/0)"]) {
      expect(absorbingExpressionError(source, "profile")).toBeUndefined();
    }
    expect(absorbingExpressionError("sqrt(-1)", "profile")).toBeTruthy();
  });
  it("checks the engine nesting limit even for a distance without sample points", () => {
    expect(absorbingExpressionError("+".repeat(128) + "x", "distance")).toBeUndefined();
    expect(absorbingExpressionError("+".repeat(129) + "x", "distance")).toBeTruthy();
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
    for (const source of ["z", "u+z", "u+", "u^2", "heaviside(u)"]) {
      expect(absorbingExpressionError(source, "profile")).toBeTruthy();
    }
  });
});
