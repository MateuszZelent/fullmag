import { describe, expect, it } from "vitest";

import {
  regionOverlayModeShowsAuthored,
  regionOverlayModeShowsRealized,
} from "./regionOverlayMode";

describe("regionOverlayMode", () => {
  it.each([
    ["authored", true, false],
    ["realized", false, true],
    ["both", true, true],
  ] as const)(
    "maps %s to the intended authored and realized layers",
    (mode, authored, realized) => {
      expect(regionOverlayModeShowsAuthored(mode)).toBe(authored);
      expect(regionOverlayModeShowsRealized(mode)).toBe(realized);
    },
  );
});
