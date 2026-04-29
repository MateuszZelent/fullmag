import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { RENDER_POLICIES_V2 } from "../../shared/renderPolicyV2";
import { applyRenderPolicy, getRenderPolicy } from "../useRenderPolicy";

describe("legacy render policy facade", () => {
  it("delegates layer policies to renderPolicyV2", () => {
    expect(getRenderPolicy("OPAQUE_GEOMETRY")).toBe(RENDER_POLICIES_V2.solidSurface);
    expect(getRenderPolicy("FIELD_GLYPHS")).toBe(RENDER_POLICIES_V2.glyphs);
    expect(getRenderPolicy("FEATURE_EDGES")).toBe(RENDER_POLICIES_V2.featureEdges);
  });

  it("applies the canonical policy to material instances", () => {
    const material = new THREE.MeshStandardMaterial();

    applyRenderPolicy(material, "SELECTION_HIGHLIGHT");

    expect(material.transparent).toBe(RENDER_POLICIES_V2.selectionShell.transparent);
    expect(material.depthWrite).toBe(RENDER_POLICIES_V2.selectionShell.depthWrite);
    expect(material.depthTest).toBe(RENDER_POLICIES_V2.selectionShell.depthTest);
    expect(material.side).toBe(RENDER_POLICIES_V2.selectionShell.side);
    expect(material.polygonOffset).toBe(RENDER_POLICIES_V2.selectionShell.polygonOffset);
    expect(material.polygonOffsetFactor).toBe(RENDER_POLICIES_V2.selectionShell.polygonOffsetFactor);

    material.dispose();
  });
});
