import { describe, expect, it } from "vitest";

import {
  regionOverlayModeShowsAuthored,
  regionOverlayModeShowsRealized,
} from "./regionOverlayMode";

describe("regionOverlayMode", () => {
  it.each([
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
