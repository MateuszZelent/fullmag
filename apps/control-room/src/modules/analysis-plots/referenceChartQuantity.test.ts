import { describe, expect, it } from "vitest";

import { isReferenceChartQuantity } from "./useAnalysisPlotsController";

describe("reference chart points", () => {
  it("are recognised so they never select a computed mode", () => {
    expect(isReferenceChartQuantity("analytic_frequency")).toBe(true);
    expect(isReferenceChartQuantity("reference_frequency")).toBe(true);
    expect(isReferenceChartQuantity("frequency")).toBe(false);
  });
});
