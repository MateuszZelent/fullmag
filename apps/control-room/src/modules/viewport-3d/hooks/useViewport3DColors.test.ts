import { describe, expect, it } from "vitest";

import { readViewport3DColorsFromStyles } from "./useViewport3DColors";

function styles(values: Record<string, string>) {
  return {
    getPropertyValue(name: string) {
      return values[name] ?? "";
    },
  };
}

describe("readViewport3DColorsFromStyles", () => {
  it("waits for required viewport theme tokens instead of returning partial colors", () => {
    expect(readViewport3DColorsFromStyles(styles({}))).toBeNull();
  });

  it("resolves viewport colors from loaded theme tokens with fallbacks", () => {
    expect(
      readViewport3DColorsFromStyles(
        styles({
          "--fm-accent": "#89b4fa",
          "--fm-bg-panel": "#1e1e2e",
          "--fm-bg-viewport": "#11111b",
          "--fm-text-secondary": "#bac2de",
        }),
      ),
    ).toEqual({
      accent: "#89b4fa",
      background: "#11111b",
      field: "#89b4fa",
      mesh: "#1e1e2e",
      wire: "#bac2de",
    });
  });
});
