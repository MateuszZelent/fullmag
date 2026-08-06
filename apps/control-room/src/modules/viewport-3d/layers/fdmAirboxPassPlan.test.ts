import { describe, expect, it } from "vitest";

import { resolveFdmAirboxPassPlan } from "./fdmAirboxPassPlan";

describe("resolveFdmAirboxPassPlan", () => {
  it("uses an extent overlay instead of dense inactive-cell geometry for wireframe", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: false,
        vectorsVisible: false,
        visible: true,
        wireframeVisible: true,
      }),
    ).toEqual({
      hasAnyEffectivePass: true,
      needsExtentOverlay: true,
      needsInactiveCellGeometry: false,
      needsVectorAnchors: false,
    });
  });

  it("requests vector anchors without requesting inactive-cell geometry", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: false,
        vectorsVisible: true,
        visible: true,
        wireframeVisible: false,
      }),
    ).toEqual({
      hasAnyEffectivePass: true,
      needsExtentOverlay: false,
      needsInactiveCellGeometry: false,
      needsVectorAnchors: true,
    });
  });

  it("suppresses every pass when Airbox master visibility is off", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: true,
        vectorsVisible: true,
        visible: false,
        wireframeVisible: true,
      }),
    ).toEqual({
      hasAnyEffectivePass: false,
      needsExtentOverlay: false,
      needsInactiveCellGeometry: false,
      needsVectorAnchors: false,
    });
  });
});
