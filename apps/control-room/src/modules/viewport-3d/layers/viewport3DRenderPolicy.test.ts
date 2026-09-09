import { BackSide, DoubleSide, FrontSide } from "three";
import { describe, expect, it } from "vitest";

import {
  RENDER_POLICIES,
  resolveSurfacePolicy,
  surfaceMaterialPolicyProps,
  surfaceMaterialPolicyPropsFront,
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

  describe("kolejność przebiegów powierzchni przezroczystych", () => {
    it("contextSurface rysuje tył przed przodem", () => {
      expect(RENDER_POLICIES.contextSurface.side).toBe(BackSide);
      expect(RENDER_POLICIES.contextSurfaceFront.side).toBe(FrontSide);
      expect(RENDER_POLICIES.contextSurface.renderOrder).toBeLessThan(
        RENDER_POLICIES.contextSurfaceFront.renderOrder,
      );
    });

    it("airbox rysuje się po powierzchni magnetycznej", () => {
      expect(RENDER_POLICIES.airSurface.renderOrder).toBeGreaterThan(
        RENDER_POLICIES.contextSurfaceFront.renderOrder,
      );
    });

    it("wszystkie renderOrder są unikalne — kolizja cicho zmienia kolejność", () => {
      const orders = Object.values(RENDER_POLICIES).map((p) => p.renderOrder);
      expect(new Set(orders).size).toBe(orders.length);
    });

    it("powierzchnia nieprzezroczysta nie ma przebiegu przedniego", () => {
      expect(surfaceMaterialPolicyPropsFront(1)).toBeNull();
      expect(surfaceMaterialPolicyPropsFront(0.5)).not.toBeNull();
    });

    it("powierzchnia nieprzezroczysta zachowuje depthWrite", () => {
      expect(surfaceMaterialPolicyProps(1).depthWrite).toBe(true);
      expect(surfaceMaterialPolicyProps(0.5).depthWrite).toBe(false);
    });
  });
});

