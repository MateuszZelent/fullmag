import { describe, expect, it } from "vitest";

import type { FdmMultilayerAirboxRenderView } from "../viewport3dDomainAdapter";
import {
  resolveFdmMultilayerAirboxBoundsOverlay,
  resolveFdmMultilayerAuthoredAirboxBoundsOverlay,
} from "./viewport3DFdmMultilayerAirboxOverlay";

const targetBounds = {
  center: [10, 20, 30] as [number, number, number],
  radius: 7,
  size: [4, 6, 8] as [number, number, number],
};

const view = {
  domain: {
    bounds: targetBounds,
    kind: "fdm-multilayer-airbox",
  },
  settings: {
    boundsVisible: true,
    wireframeVisible: true,
    visible: true,
  },
  target: { id: "airbox", kind: "airbox" },
} as FdmMultilayerAirboxRenderView;

describe("FDM multilayer Airbox bounds overlay model", () => {
  it("uses target-grid bounds for both extent and full hidden-edge wireframe", () => {
    expect(resolveFdmMultilayerAirboxBoundsOverlay(view)).toEqual({
      bounds: targetBounds,
      boundsVisible: true,
      fullWireframeVisible: true,
      targetId: "airbox",
    });
  });

  it("does not accept or consult legacy universe/common-grid bounds", () => {
    const candidate = {
      ...view,
      domain: {
        ...view.domain,
        bounds: targetBounds,
      },
      legacyUniverseBounds: {
        center: [100, 100, 100],
        radius: 100,
        size: [200, 200, 200],
      },
      commonTransformBounds: {
        center: [-100, -100, -100],
        radius: 100,
        size: [200, 200, 200],
      },
    } as FdmMultilayerAirboxRenderView & {
      legacyUniverseBounds: typeof targetBounds;
      commonTransformBounds: typeof targetBounds;
    };

    expect(resolveFdmMultilayerAirboxBoundsOverlay(candidate)?.bounds).toBe(
      targetBounds,
    );
  });

  it("fails closed when the view is not the canonical Airbox target", () => {
    expect(
      resolveFdmMultilayerAirboxBoundsOverlay({
        ...view,
        target: { id: "fdm-universe-outside-support", kind: "fdm-domain" },
      }),
    ).toBeNull();
  });

  it.each([
    ["hidden target", { visible: false }],
    ["bounds and wireframe hidden", { boundsVisible: false, wireframeVisible: false }],
  ] as const)("fails closed for %s", (_label, settings) => {
    expect(
      resolveFdmMultilayerAirboxBoundsOverlay({
        ...view,
        settings: { ...view.settings, ...settings },
      }),
    ).toBeNull();
  });
});

describe("FDM multilayer authored Airbox extent before a carrier is published", () => {
  const universeBounds = {
    center: [0, 0, 1] as [number, number, number],
    radius: 3,
    size: [4, 2, 2] as [number, number, number],
  };

  it("draws the authored Universe extent and wireframe while no carrier exists", () => {
    expect(
      resolveFdmMultilayerAuthoredAirboxBoundsOverlay(null, universeBounds, view.settings),
    ).toEqual({
      bounds: universeBounds,
      boundsVisible: true,
      fullWireframeVisible: true,
      targetId: "airbox",
    });
  });

  it("yields to a published carrier view and to hidden settings", () => {
    expect(
      resolveFdmMultilayerAuthoredAirboxBoundsOverlay(view, universeBounds, view.settings),
    ).toBeNull();
    expect(
      resolveFdmMultilayerAuthoredAirboxBoundsOverlay(null, universeBounds, {
        ...view.settings,
        boundsVisible: false,
        wireframeVisible: false,
      }),
    ).toBeNull();
    expect(
      resolveFdmMultilayerAuthoredAirboxBoundsOverlay(null, null, view.settings),
    ).toBeNull();
  });
});
