import { describe, expect, it } from "vitest";

import { sameViewport3DFieldRenderOptions } from "./useViewport3DFieldRenderOptions";

describe("sameViewport3DFieldRenderOptions", () => {
  it("treats equivalent field render options as stable despite fresh maps", () => {
    expect(
      sameViewport3DFieldRenderOptions(
        {
          fullVectorBudget: 12,
          partVectorBudgets: new Map([
            ["part-a", 8],
            ["part-b", 4],
          ]),
          partVectorScopes: new Map([
            ["part-a", "surface"],
            ["part-b", "full"],
          ]),
          scalarColorModes: new Set(["orientation", "magnitude"]),
          scalarColorsVisible: true,
          vectorColorMode: "orientation",
        },
        {
          fullVectorBudget: 12,
          partVectorBudgets: new Map([
            ["part-a", 8],
            ["part-b", 4],
          ]),
          partVectorScopes: new Map([
            ["part-a", "surface"],
            ["part-b", "full"],
          ]),
          scalarColorModes: new Set(["magnitude", "orientation"]),
          scalarColorsVisible: true,
          vectorColorMode: "orientation",
        },
      ),
    ).toBe(true);
  });

  it("detects changed vector budgets", () => {
    expect(
      sameViewport3DFieldRenderOptions(
        {
          partVectorBudgets: new Map([["part-a", 8]]),
        },
        {
          partVectorBudgets: new Map([["part-a", 9]]),
        },
      ),
    ).toBe(false);
  });

  it("detects changed vector placement options", () => {
    expect(
      sameViewport3DFieldRenderOptions(
        {
          fullVectorAnchorMode: "center",
          partVectorSurfaceOffsetScales: new Map([["part-a", 0.1]]),
        },
        {
          fullVectorAnchorMode: "tail",
          partVectorSurfaceOffsetScales: new Map([["part-a", 0]]),
        },
      ),
    ).toBe(false);
  });
});
