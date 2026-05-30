import { describe, expect, it } from "vitest";

import {
  sameViewport3DFieldRenderOptions,
  viewport3DAirboxVectorsVisible,
} from "./useViewport3DFieldRenderOptions";

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

  it("does not request airbox vector fields when the airbox target is hidden", () => {
    expect(
      viewport3DAirboxVectorsVisible(
        false,
        true,
        true,
        "all",
      ),
    ).toBe(false);
  });

  it("allows airbox vector fields only for visible airbox-compatible domains", () => {
    expect(viewport3DAirboxVectorsVisible(true, true, true, "all")).toBe(true);
    expect(viewport3DAirboxVectorsVisible(true, true, true, "airbox_only")).toBe(true);
    expect(viewport3DAirboxVectorsVisible(true, true, true, "magnetic_only")).toBe(false);
    expect(viewport3DAirboxVectorsVisible(true, true, true, "object")).toBe(false);
    expect(viewport3DAirboxVectorsVisible(true, true, true, "part")).toBe(false);
  });

  it("does not allow airbox vectors for magnetic-only quantities", () => {
    expect(viewport3DAirboxVectorsVisible(true, true, false, "all")).toBe(false);
  });
});
