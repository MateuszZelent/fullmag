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
          "--fm-surface-antenna": "#f9e2af",
          "--fm-success": "#a6e3a1",
          "--fm-text-primary": "#cdd6f4",
          "--fm-text-secondary": "#bac2de",
        }),
      ),
    ).toEqual({
      accent: "#89b4fa",
      antenna: "#f9e2af",
      accentStrong: "#b4befe",
      background: "#11111b",
      danger: "#f38ba8",
      field: "#89b4fa",
      hud: {
        axisX: "#cdd6f4",
        axisY: "#cdd6f4",
        axisZ: "#cdd6f4",
        chip: "#1e1e2e",
        chipBorder: "#bac2de",
        cubeEdge: "#bac2de",
        cubeFace: "#313244",
        cubeShade: "#11111b",
        grid: "#bac2de",
        halo: "#11111b",
        label: "#cdd6f4",
        tick: "#bac2de",
      },
      mesh: "#1e1e2e",
      panel: "#1e1e2e",
      panelRaised: "#313244",
      success: "#a6e3a1",
      textPrimary: "#cdd6f4",
      textSecondary: "#bac2de",
      wire: "#bac2de",
    });
  });

  it("prefers dedicated HUD tokens so labels follow the active theme", () => {
    const colors = readViewport3DColorsFromStyles(
      styles({
        "--fm-accent": "#1e66f5",
        "--fm-bg-panel": "#eff1f5",
        "--fm-bg-viewport": "#dce0e8",
        "--fm-hud-axis-x": "#d20f39",
        "--fm-hud-axis-y": "#40a02b",
        "--fm-hud-axis-z": "#1e66f5",
        "--fm-hud-halo": "#dce0e8",
        "--fm-hud-cube-face": "#eff1f5",
        "--fm-text-primary": "#4c4f69",
        "--fm-text-secondary": "#5c5f77",
      }),
    );

    expect(colors?.hud).toMatchObject({
      axisX: "#d20f39",
      axisY: "#40a02b",
      axisZ: "#1e66f5",
      cubeFace: "#eff1f5",
      halo: "#dce0e8",
      label: "#4c4f69",
      tick: "#5c5f77",
    });
  });
});
