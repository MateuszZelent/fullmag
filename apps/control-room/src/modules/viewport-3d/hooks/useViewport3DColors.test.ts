import { describe, expect, it } from "vitest";

import {
  readViewport3DColorsFromStyles,
  resolveViewport3DColorElement,
} from "./useViewport3DColors";

function styles(values: Record<string, string>) {
  return {
    getPropertyValue(name: string) {
      return values[name] ?? "";
    },
  };
}

describe("readViewport3DColorsFromStyles", () => {
  it("uses the body as the effective theme source when present", () => {
    const body = {} as Element;
    const documentElement = {} as Element;

    expect(
      resolveViewport3DColorElement({ body, documentElement }),
    ).toBe(body);
  });

  it("waits for required viewport theme tokens instead of returning partial colors", () => {
    expect(readViewport3DColorsFromStyles(styles({}))).toBeNull();
  });

  it("resolves viewport colors from loaded theme tokens with fallbacks", () => {
    expect(
      readViewport3DColorsFromStyles(
        styles({
          "--fm-accent": "#89b4fa",
          "--fm-accent-strong": "#b4befe",
          "--fm-bg-panel": "#1e1e2e",
          "--fm-bg-panel-raised": "#313244",
          "--fm-bg-viewport": "#11111b",
          "--fm-danger": "#f38ba8",
          "--fm-success": "#a6e3a1",
          "--fm-text-primary": "#cdd6f4",
          "--fm-text-secondary": "#bac2de",
        }),
      ),
    ).toEqual({
      accent: "#89b4fa",
      accentStrong: "#b4befe",
      background: "#11111b",
      danger: "#f38ba8",
      field: "#89b4fa",
      mesh: "#1e1e2e",
      panel: "#1e1e2e",
      panelRaised: "#313244",
      success: "#a6e3a1",
      textPrimary: "#cdd6f4",
      textSecondary: "#bac2de",
      wire: "#bac2de",
    });
  });
});
