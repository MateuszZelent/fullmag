import { describe, expect, it } from "vitest";

import {
  clampViewport3DInteractiveVectorBudget,
  limitViewport3DFieldRenderVectorBudgets,
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

  it("detects changed full-domain surface color options", () => {
    expect(
      sameViewport3DFieldRenderOptions(
        {
          fullScalarColorMode: "x",
          fullScalarColorPalette: "viridis",
          scalarColorsVisible: true,
        },
        {
          fullScalarColorMode: "y",
          fullScalarColorPalette: "inferno",
          scalarColorsVisible: true,
        },
      ),
    ).toBe(false);
  });

  it("detects changed per-target active quantities", () => {
    expect(
      sameViewport3DFieldRenderOptions(
        {
          partQuantityIds: new Map([["part-a", "m"]]),
        },
        {
          partQuantityIds: new Map([["part-a", "H_eff"]]),
        },
      ),
    ).toBe(false);
  });

  it("detects changed surface lift enablement independently from extra gap", () => {
    expect(
      sameViewport3DFieldRenderOptions(
        {
          fullVectorSurfaceOffsetEnabled: true,
          fullVectorSurfaceOffsetScale: 0,
          partVectorSurfaceOffsetEnabled: new Set(["part-a"]),
          partVectorSurfaceOffsetScales: new Map([["part-a", 0]]),
        },
        {
          fullVectorSurfaceOffsetEnabled: false,
          fullVectorSurfaceOffsetScale: 0,
          partVectorSurfaceOffsetEnabled: new Set(),
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

  it("does not reduce an explicit Airbox target budget to the session fallback", () => {
    const limited = limitViewport3DFieldRenderVectorBudgets(
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:__air__", 48_461]]),
        partVectorScopes: new Map([["part:__air__", "full"]]),
      },
      {
        airboxParts: [
          {
            part: {
              id: "part:__air__",
              nodeCount: 58_224,
            },
            surfaceNodeSelection: null,
          },
        ],
        magneticParts: [],
        nodeCount: 61_689,
      } as never,
      2048,
    );

    expect(limited.partVectorBudgets).toEqual(
      new Map([["part:__air__", 48_461]]),
    );
  });

  it("keeps the full effective Airbox budget while sharing the fallback across magnetic targets", () => {
    const airOnlyNodeIndices = Array.from(
      { length: 10_604 },
      (_, index) => index + 9_595,
    );
    const limited = limitViewport3DFieldRenderVectorBudgets(
      {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([
          ["part:film", 10_604],
          ["part:__air__", 10_604],
        ]),
        partVectorScopes: new Map([
          ["part:film", "surface"],
          ["part:__air__", "full"],
        ]),
      },
      {
        airboxParts: [
          {
            fullNodeSelection: { nodeIndices: airOnlyNodeIndices },
            part: {
              id: "part:__air__",
              node_count: 16_959,
              role: "air",
            },
            surfaceNodeSelection: null,
          },
        ],
        magneticParts: [
          {
            fullNodeSelection: { nodeCount: 7_903, nodeStart: 0 },
            part: {
              id: "part:film",
              node_count: 7_903,
              object_id: "film",
              role: "magnetic_object",
            },
            surfaceNodeSelection: {
              nodeIndices: Array.from({ length: 6_099 }, (_, index) => index),
            },
          },
        ],
        nodeCount: 20_199,
      } as never,
      16_384,
    );

    expect(limited.partVectorBudgets?.get("part:__air__")).toBe(10_604);
    expect(limited.partVectorBudgets?.get("part:film")).toBe(6_099);
  });

  it("keeps small requested vector budgets below the interactive cap", () => {
    expect(clampViewport3DInteractiveVectorBudget(512, 2048)).toBe(512);
    expect(clampViewport3DInteractiveVectorBudget(48_461, 2048)).toBe(2048);
  });
});
