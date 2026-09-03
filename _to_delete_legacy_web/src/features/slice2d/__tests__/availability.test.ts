import { describe, expect, it } from "vitest";

import { resolveSlice2DAvailability } from "../availability";

describe("resolveSlice2DAvailability", () => {
  it("enables FEM single-slice mesh and airbox when airbox parts exist", () => {
    const availability = resolveSlice2DAvailability({
      isFemBackend: true,
      mode: "single",
      hasAirboxParts: true,
    });

    expect(availability.meshOverlay).toMatchObject({ enabled: true, reason: null });
    expect(availability.airbox).toMatchObject({ enabled: true, reason: null });
    expect(availability.airboxVectors).toMatchObject({
      enabled: false,
      maturity: "staged",
    });
  });

  it("keeps FDM and projection-only paths disabled with concrete reasons", () => {
    const fdm = resolveSlice2DAvailability({
      isFemBackend: false,
      mode: "single",
      hasAirboxParts: false,
    });
    const allLayers = resolveSlice2DAvailability({
      isFemBackend: true,
      mode: "all_layers",
      hasAirboxParts: true,
    });

    expect(fdm.meshOverlay).toMatchObject({
      enabled: false,
      reason: "2D mesh overlay requires FEM explicit topology",
    });
    expect(fdm.airbox).toMatchObject({
      enabled: false,
      reason: "2D airbox overlay requires FEM explicit topology",
    });
    expect(allLayers.meshOverlay).toMatchObject({
      enabled: false,
      reason: "2D mesh overlay currently supports Single mode only",
    });
    expect(allLayers.airbox).toMatchObject({
      enabled: false,
      reason: "2D airbox overlay currently supports Single mode only",
    });
  });
});
