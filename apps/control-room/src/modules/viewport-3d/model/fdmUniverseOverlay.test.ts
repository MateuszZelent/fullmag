import { describe, expect, it } from "vitest";

import {
  hasExplicitFdmUniverseOutsideMagneticSupportRole,
  resolveFdmUniverseOutsideSupportOverlayModel,
} from "./fdmUniverseOverlay";

const support = {
  center: [0, 0, 0] as [number, number, number],
  radius: 1,
  size: [2, 2, 2] as [number, number, number],
};

describe("resolveFdmUniverseOutsideSupportOverlayModel", () => {
  it("requires an explicit universe semantic role instead of inferring from config presence", () => {
    expect(
      hasExplicitFdmUniverseOutsideMagneticSupportRole({ size: [4, 4, 4] }),
    ).toBe(false);
    expect(
      hasExplicitFdmUniverseOutsideMagneticSupportRole({
        semantic_role: "universe-outside-magnetic-support",
      }),
    ).toBe(true);
  });

  it("creates a separate universe overlay only for an explicit outside-support role", () => {
    const universe = {
      center: [0, 0, 0] as [number, number, number],
      radius: 2,
      size: [4, 4, 4] as [number, number, number],
    };

    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        magneticSupportBounds: support,
        semanticRole: "universe-outside-magnetic-support",
        universeBounds: universe,
      }),
    ).toEqual({
      kind: "fdm-universe-outside-magnetic-support",
      magneticSupportBounds: support,
      universeBounds: universe,
    });
  });

  it("does not infer air or void from a mask without the semantic role", () => {
    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        magneticSupportBounds: support,
        semanticRole: null,
        universeBounds: {
          center: [0, 0, 0],
          radius: 2,
          size: [4, 4, 4],
        },
      }),
    ).toBeNull();
  });

  it("does not create an overlay when universe and magnetic support coincide", () => {
    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        magneticSupportBounds: support,
        semanticRole: "universe-outside-magnetic-support",
        universeBounds: support,
      }),
    ).toBeNull();
  });

  it("rejects a partially overlapping universe envelope", () => {
    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        magneticSupportBounds: support,
        semanticRole: "universe-outside-magnetic-support",
        universeBounds: {
          center: [1.25, 0, 0],
          radius: 2,
          size: [4, 4, 4],
        },
      }),
    ).toBeNull();
  });
});
