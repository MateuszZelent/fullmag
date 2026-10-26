import { describe, expect, it } from "vitest";

import { colorValueLabel, computedRgbToHex, isThemeColorToken } from "./colorValueLabel";

describe("colorValueLabel", () => {
  it("names theme tokens instead of showing raw CSS", () => {
    expect(colorValueLabel("var(--fm-surface-magnetic)")).toBe("Theme · surface magnetic");
    expect(colorValueLabel("var(--fm-chart-sky, #04a5e5)")).toBe("Theme · chart sky");
  });

  it("recognizes theme tokens", () => {
    expect(isThemeColorToken("var(--fm-border-strong)")).toBe(true);
    expect(isThemeColorToken("#123456")).toBe(false);
  });

  it("normalizes hex and keeps other values", () => {
    expect(colorValueLabel("#1e66f5")).toBe("#1E66F5");
    expect(colorValueLabel("tomato")).toBe("tomato");
    expect(colorValueLabel("")).toBe("Not set");
  });

  it("converts computed rgb to hex", () => {
    expect(computedRgbToHex("rgb(30, 102, 245)")).toBe("#1e66f5");
    expect(computedRgbToHex("rgba(0, 0, 0, 0.5)")).toBe("#000000");
    expect(computedRgbToHex("transparent")).toBeNull();
  });
});
