import { describe, expect, it } from "vitest";

import { resolveFdmAirboxPassPlan } from "./fdmAirboxPassPlan";

describe("resolveFdmAirboxPassPlan", () => {
  it("uses inactive-cell geometry for the Airbox wireframe", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: false,
        pointsVisible: false,
        vectorsVisible: false,
        visible: true,
        wireframeVisible: true,
      }),
    ).toEqual({
      hasAnyEffectivePass: true,
      needsExtentOverlay: false,
      needsInactiveCellGeometry: true,
      needsPointGeometry: false,
      needsSurfaceInstances: true,
      needsVectorAnchors: false,
    });
  });

  it("uses inactive-cell geometry for Airbox points", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: false,
        pointsVisible: true,
        vectorsVisible: false,
        visible: true,
        wireframeVisible: false,
      }),
    ).toEqual({
      hasAnyEffectivePass: true,
      needsExtentOverlay: false,
      needsInactiveCellGeometry: true,
      needsPointGeometry: true,
      needsSurfaceInstances: false,
      needsVectorAnchors: false,
    });
  });

  it("requests vector anchors from the same inactive-cell geometry", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: false,
        pointsVisible: false,
        vectorsVisible: true,
        visible: true,
        wireframeVisible: false,
      }),
    ).toEqual({
      hasAnyEffectivePass: true,
      needsExtentOverlay: false,
      needsInactiveCellGeometry: true,
      needsPointGeometry: false,
      needsSurfaceInstances: false,
      needsVectorAnchors: true,
    });
  });

  it("keeps the Bounds frame independent from Airbox mesh geometry", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: true,
        pointsVisible: false,
        vectorsVisible: false,
        visible: true,
        wireframeVisible: false,
      }),
    ).toEqual({
      hasAnyEffectivePass: true,
      needsExtentOverlay: true,
      needsInactiveCellGeometry: false,
      needsPointGeometry: false,
      needsSurfaceInstances: false,
      needsVectorAnchors: false,
    });
  });

  it("suppresses every pass when Airbox master visibility is off", () => {
    expect(
      resolveFdmAirboxPassPlan({
        boundsVisible: true,
        pointsVisible: true,
        vectorsVisible: true,
        visible: false,
        wireframeVisible: true,
      }),
    ).toEqual({
      hasAnyEffectivePass: false,
      needsExtentOverlay: false,
      needsInactiveCellGeometry: false,
      needsPointGeometry: false,
      needsSurfaceInstances: false,
      needsVectorAnchors: false,
    });
  });
});
