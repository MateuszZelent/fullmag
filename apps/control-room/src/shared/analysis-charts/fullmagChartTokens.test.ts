import { describe, expect, it } from "vitest";

import {
  CHART_COLOR_NAMES,
  paletteFromTokens,
  resolveChartTokens,
  rgbaWithAlpha,
} from "./fullmagChartTokens";

describe("fullmagChartTokens", () => {
  it("defines 12 index-stable chart color names", () => {
    expect(CHART_COLOR_NAMES).toHaveLength(12);
    expect(CHART_COLOR_NAMES[0]).toBe("blue");
    expect(CHART_COLOR_NAMES[1]).toBe("green");
  });

  it("rgbaWithAlpha converts color strings to rgba with given alpha", () => {
    expect(rgbaWithAlpha("rgb(137, 180, 250)", 0.5)).toBe("rgba(137, 180, 250, 0.5)");
    expect(rgbaWithAlpha("rgba(137, 180, 250, 1)", 0.12)).toBe("rgba(137, 180, 250, 0.12)");
    expect(rgbaWithAlpha("#89b4fa", 0.12)).toBe("rgba(137, 180, 250, 0.12)");
  });

  it("resolveChartTokens extracts 12 palette colors and structural tokens from element", () => {
    const mockElem = {} as Element;
    const tokens = resolveChartTokens(mockElem);
    expect(tokens.palette).toHaveLength(12);
    expect(tokens.fontFamily).toBeTruthy();
    expect(tokens.accentFill).toContain("rgba(");
  });

  it("paletteFromTokens returns array of palette colors", () => {
    const mockElem = {} as Element;
    const tokens = resolveChartTokens(mockElem);
    const palette = paletteFromTokens(tokens);
    expect(palette).toEqual(tokens.palette);
  });
});
