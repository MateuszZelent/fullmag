import { DoubleSide } from "three";
import { describe, expect, it } from "vitest";

import {
  RENDER_POLICIES,
  resolveSurfacePolicy,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

describe("viewport3DRenderPolicy", () => {
  it("renders opaque magnetic surfaces double-sided without transparent sorting", () => {
    expect(resolveSurfacePolicy(1)).toMatchObject({
      depthTest: true,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      renderOrder: 0,
      side: DoubleSide,
      transparent: false,
    });
  });

  it("keeps polygon offset enabled for both opaque and transparent surfaces", () => {
    expect(surfaceMaterialPolicyProps(1)).toMatchObject({
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      transparent: false,
    });
    expect(surfaceMaterialPolicyProps(0.4)).toMatchObject({
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      transparent: true,
    });
  });

  it("draws edge passes after surfaces without depth writes", () => {
    expect(RENDER_POLICIES.featureEdges.renderOrder).toBeGreaterThan(
      RENDER_POLICIES.contextSurface.renderOrder,
    );
    expect(RENDER_POLICIES.featureEdges).toMatchObject({
      depthTest: true,
      depthWrite: false,
      transparent: true,
    });
  });
});
