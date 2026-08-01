import { describe, expect, it } from "vitest";

import {
  DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE,
  regionDiagnosticOverlayMode,
  regionOverlayModeShowsAuthored,
  regionOverlayModeShowsRealized,
} from "./regionOverlayMode";

describe("regionOverlayMode", () => {
  it("starts diagnostics disabled while retaining auto source selection", () => {
    expect(DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE).toEqual({
      source: "auto",
      visible: false,
    });
    expect(
      regionDiagnosticOverlayMode(DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE),
    ).toBe("off");
    expect(
      regionDiagnosticOverlayMode({ source: "realized", visible: true }),
    ).toBe("realized");
  });
  it.each([
    ["off", false, false, false],
    ["off", true, false, false],
    ["authored", false, true, false],
    ["realized", false, false, true],
    ["both", false, true, true],
    ["auto", false, true, false],
    ["auto", true, false, true],
  ] as const)(
    "maps %s with mesh-backed=%s to the intended authored and realized layers",
    (mode, hasMeshBackedRegions, authored, realized) => {
      expect(regionOverlayModeShowsAuthored(mode, hasMeshBackedRegions)).toBe(
        authored,
      );
      expect(regionOverlayModeShowsRealized(mode, hasMeshBackedRegions)).toBe(
        realized,
      );
    },
  );
});
