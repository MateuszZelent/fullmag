import { describe, expect, it } from "vitest";

import {
  resolveFemOrientationLegendVisibility,
  resolveFemOverlayLegendVisibility,
} from "../useFemOverlayItems";

describe("resolveFemOrientationLegendVisibility", () => {
  it("stays visible when the surface legend uses orientation", () => {
    expect(
      resolveFemOrientationLegendVisibility({
        requested: false,
        surfaceColorField: "orientation",
        arrowColorMode: "monochrome",
        effectiveShowArrows: false,
      }),
    ).toBe(true);
  });

  it("stays visible when arrows use orientation and a linear colorbar is active", () => {
    expect(
      resolveFemOrientationLegendVisibility({
        requested: false,
        surfaceColorField: "magnitude",
        arrowColorMode: "orientation",
        effectiveShowArrows: true,
      }),
    ).toBe(true);
  });

  it("stays hidden when neither surface nor arrows use orientation", () => {
    expect(
      resolveFemOrientationLegendVisibility({
        requested: false,
        surfaceColorField: "magnitude",
        arrowColorMode: "x",
        effectiveShowArrows: true,
      }),
    ).toBe(false);
  });

  it("stays hidden for scalar quality coloring unless arrows use orientation", () => {
    expect(
      resolveFemOrientationLegendVisibility({
        requested: false,
        surfaceColorField: "quality",
        arrowColorMode: "monochrome",
        effectiveShowArrows: false,
      }),
    ).toBe(false);
    expect(
      resolveFemOrientationLegendVisibility({
        requested: false,
        surfaceColorField: "sicn",
        arrowColorMode: "orientation",
        effectiveShowArrows: true,
      }),
    ).toBe(true);
  });
});

describe("resolveFemOverlayLegendVisibility", () => {
  it("shows orientation reference for orientation surface even when the linear legend is closed", () => {
    expect(
      resolveFemOverlayLegendVisibility({
        legendOpen: false,
        colorLegendField: null,
        fieldLegendEnabled: true,
        orientationReferenceEnabled: true,
        requestedOrientationReference: false,
        surfaceColorField: "orientation",
        arrowColorMode: "monochrome",
        effectiveShowArrows: false,
      }),
    ).toEqual({
      showColorLegend: false,
      orientationReferenceVisible: true,
    });
  });

  it("keeps linear colorbar tied to legendOpen and linear fields", () => {
    expect(
      resolveFemOverlayLegendVisibility({
        legendOpen: false,
        colorLegendField: "magnitude",
        fieldLegendEnabled: true,
        orientationReferenceEnabled: true,
        requestedOrientationReference: false,
        surfaceColorField: "magnitude",
        arrowColorMode: "monochrome",
        effectiveShowArrows: false,
      }),
    ).toEqual({
      showColorLegend: false,
      orientationReferenceVisible: false,
    });
    expect(
      resolveFemOverlayLegendVisibility({
        legendOpen: true,
        colorLegendField: "magnitude",
        fieldLegendEnabled: true,
        orientationReferenceEnabled: true,
        requestedOrientationReference: false,
        surfaceColorField: "magnitude",
        arrowColorMode: "monochrome",
        effectiveShowArrows: false,
      }),
    ).toEqual({
      showColorLegend: true,
      orientationReferenceVisible: false,
    });
  });
});
