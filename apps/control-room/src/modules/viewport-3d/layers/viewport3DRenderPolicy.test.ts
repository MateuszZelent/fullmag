import { FrontSide } from "three";
import { describe, expect, it } from "vitest";

import {
  RENDER_POLICIES,
  resolveSurfacePolicy,
} from "./viewport3DRenderPolicy";

describe("viewport3DRenderPolicy", () => {
  it("keeps opaque magnetic surfaces out of transparent sorting", () => {
    expect(resolveSurfacePolicy(1)).toMatchObject({
      depthTest: true,
      depthWrite: true,
      renderOrder: 0,
      side: FrontSide,
      transparent: false,
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
