import { describe, expect, it } from "vitest";

import {
  resolveFdmUniverseOutsideSupportOverlayFromPresentation,
  resolveFdmUniverseOutsideSupportOverlayModel,
} from "./fdmUniverseOverlay";
import type {
  FdmDomainPresentation,
  FdmMagneticSupportPresentation,
} from "@/shared/domain/mesh/domainPresentation";

const support = {
  center: [0, 0, 0] as [number, number, number],
  radius: 1,
  size: [2, 2, 2] as [number, number, number],
};

function fdmPresentation({
  magneticSupport,
  resourceStatus = "realized",
  universeOutsideMagneticSupport = null,
}: {
  magneticSupport: FdmMagneticSupportPresentation | null;
  resourceStatus?: FdmDomainPresentation["resourceStatus"];
  universeOutsideMagneticSupport?: FdmDomainPresentation["universeOutsideMagneticSupport"];
}): FdmDomainPresentation {
  return {
    airbox: null,
    bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    discretization: "fdm",
    domainId: "domain:fdm",
    fdmGrid: {
      declaredCellCount: 8,
      descriptor: {
        origin: [-2, -2, -2],
        shape: [2, 2, 2],
        spacing: [2, 2, 2],
      },
      descriptorCellCountCompatible: true,
      gridFingerprint: "grid:1",
      membership: null,
      membershipStatus: resourceStatus,
      origin: [-2, -2, -2],
      shape: [2, 2, 2],
      spacing: [2, 2, 2],
      totalCells: 8,
    },
    femTopology: null,
    fingerprint: "grid:1",
    generationId: "generation:1",
    magneticSupport,
    resourceStatus,
    revision: "generation:1:1:1",
    units: { length: "m" },
    universeOutsideMagneticSupport,
  };
}

describe("resolveFdmUniverseOutsideSupportOverlayModel", () => {
  it("creates a separate universe overlay only for an explicit outside-support role", () => {
    const universe = {
      center: [0, 0, 0] as [number, number, number],
      radius: 2,
      size: [4, 4, 4] as [number, number, number],
    };

    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        activeCellCount: 6,
        inactiveCellCount: 2,
        magneticSupportBounds: support,
        semanticRole: "universe-outside-magnetic-support",
        universeBounds: universe,
      }),
    ).toEqual({
      activeCellCount: 6,
      kind: "fdm-universe-outside-magnetic-support",
      legend: {
        magneticSupport: "Magnetic support · 6 active cells",
        outsideSupport: "Airbox · 2 inactive cells",
      },
      magneticSupportBounds: support,
      inactiveCellCount: 2,
      target: {
        id: "fdm-universe-outside-support",
        kind: "fdm-domain",
        label: "Airbox",
      },
      universeBounds: universe,
    });
  });

  it("builds the overlay from a validated current DomainPresentation support summary", () => {
    const presentation = fdmPresentation({
      magneticSupport: {
        activeCellCount: 6,
        activeUnassignedCellCount: 1,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        inactiveCellCount: 2,
        kind: "magnetic-support",
      },
    });

    expect(
      resolveFdmUniverseOutsideSupportOverlayFromPresentation(presentation),
    ).toMatchObject({
      kind: "fdm-universe-outside-magnetic-support",
      legend: {
        magneticSupport: "Magnetic support · 6 active cells",
        outsideSupport: "Airbox · 2 inactive cells",
      },
      magneticSupportBounds: { center: [0, 0, 0], size: [2, 2, 2] },
      universeBounds: { center: [0, 0, 0], size: [4, 4, 4] },
    });
  });

  it("builds a bounds-only authored overlay before FDM membership materializes", () => {
    const presentation = fdmPresentation({
      magneticSupport: null,
      resourceStatus: "authoring-grid",
      universeOutsideMagneticSupport: {
        bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
        magneticSupportBounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        kind: "universe-outside-magnetic-support",
        reason: "authored-universe-exceeds-magnetic-support",
      },
    });

    expect(
      resolveFdmUniverseOutsideSupportOverlayFromPresentation(presentation),
    ).toMatchObject({
      kind: "fdm-universe-outside-magnetic-support",
      legend: {
        magneticSupport: "Magnetic support · authored bounds",
        outsideSupport: "Airbox · membership pending",
      },
      magneticSupportBounds: { center: [0, 0, 0], size: [2, 2, 2] },
      universeBounds: { center: [0, 0, 0], size: [4, 4, 4] },
    });
  });

  it("uses an explicit universe-outside-support envelope instead of generic domain bounds", () => {
    const presentation = fdmPresentation({
      magneticSupport: {
        activeCellCount: 6,
        activeUnassignedCellCount: 1,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        inactiveCellCount: 2,
        kind: "magnetic-support",
      },
      universeOutsideMagneticSupport: {
        bounds: { min: [-3, -2, -1.5], max: [3, 2, 1.5] },
        kind: "universe-outside-magnetic-support",
        reason: "backend-declared-universe-outside-magnetic-support",
      },
    });

    expect(
      resolveFdmUniverseOutsideSupportOverlayFromPresentation(presentation),
    ).toMatchObject({
      universeBounds: {
        center: [0, 0, 0],
        size: [6, 4, 3],
      },
    });
  });

  it("fails closed for stale presentation identity or absent outside-support cells", () => {
    const presentation = fdmPresentation({
      magneticSupport: {
        activeCellCount: 8,
        activeUnassignedCellCount: 0,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        inactiveCellCount: 0,
        kind: "magnetic-support",
      },
      resourceStatus: "stale",
    });
    expect(
      resolveFdmUniverseOutsideSupportOverlayFromPresentation(presentation),
    ).toBeNull();
    expect(
      resolveFdmUniverseOutsideSupportOverlayFromPresentation(fdmPresentation({
        magneticSupport: presentation.magneticSupport,
        resourceStatus: "realized",
      })),
    ).toBeNull();
  });

  it("does not infer air or void from a mask without the semantic role", () => {
    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        activeCellCount: 8,
        inactiveCellCount: 0,
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
        activeCellCount: 8,
        inactiveCellCount: 0,
        magneticSupportBounds: support,
        semanticRole: "universe-outside-magnetic-support",
        universeBounds: support,
      }),
    ).toBeNull();
  });

  it("rejects a partially overlapping universe envelope", () => {
    expect(
      resolveFdmUniverseOutsideSupportOverlayModel({
        activeCellCount: 8,
        inactiveCellCount: 0,
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
