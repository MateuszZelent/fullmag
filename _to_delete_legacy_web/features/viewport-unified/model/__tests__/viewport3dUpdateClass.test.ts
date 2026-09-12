import { describe, expect, it } from "vitest";

import {
  buildViewport3DUpdateSignature,
  resolveViewport3DUpdateClass,
  type Viewport3DUpdateSignature,
} from "../viewport3dUpdateClass";

const base: Viewport3DUpdateSignature = {
  topologyRevision: "topology:1",
  fieldRevision: "field:1",
  presentationKey: "m|3D|surface",
};

describe("resolveViewport3DUpdateClass", () => {
  it("treats the first committed viewport state as initial", () => {
    expect(resolveViewport3DUpdateClass(null, base)).toBe("initial");
  });

  it("prioritizes topology changes over field and presentation changes", () => {
    expect(
      resolveViewport3DUpdateClass(base, {
        topologyRevision: "topology:2",
        fieldRevision: "field:2",
        presentationKey: "m|x|wireframe",
      }),
    ).toBe("topology_revision_changed");
  });

  it("classifies field-only updates without treating them as presentation updates", () => {
    expect(
      resolveViewport3DUpdateClass(base, {
        ...base,
        fieldRevision: "field:2",
      }),
    ).toBe("field_revision_changed");
  });

  it("classifies quantity/component/render changes as presentation-only", () => {
    expect(
      resolveViewport3DUpdateClass(base, {
        ...base,
        presentationKey: "m|x|surface",
      }),
    ).toBe("presentation_changed");
  });

  it("returns no_change for an identical signature", () => {
    expect(resolveViewport3DUpdateClass(base, { ...base })).toBe("no_change");
  });
});

describe("buildViewport3DUpdateSignature", () => {
  it("keeps presentation stable across field-only updates", () => {
    const baseArgs = {
      topologyRevision: "topology:1",
      dataFieldRevision: "field:1",
      effectiveViewMode: "3D",
      selectedQuantity: "m",
      effectiveVectorComponent: "3D",
      meshRenderMode: "surface",
      meshClipEnabled: false,
      meshClipAxis: "x",
      meshClipPos: 50,
      femVectorDomainFilter: "magnetic",
      femFerromagnetVisibilityMode: "context",
    };

    const first = buildViewport3DUpdateSignature({
      ...baseArgs,
      meshFieldRevision: "field:1",
    });
    const next = buildViewport3DUpdateSignature({
      ...baseArgs,
      meshFieldRevision: "field:2",
      dataFieldRevision: "field:2",
    });

    expect(next.presentationKey).toBe(first.presentationKey);
    expect(resolveViewport3DUpdateClass(first, next)).toBe("field_revision_changed");
  });

  it("classifies clip changes as presentation-only", () => {
    const first = buildViewport3DUpdateSignature({
      topologyRevision: "topology:1",
      meshFieldRevision: "field:1",
      dataFieldRevision: "field:1",
      effectiveViewMode: "3D",
      selectedQuantity: "m",
      effectiveVectorComponent: "3D",
      meshRenderMode: "surface",
      meshClipEnabled: false,
      meshClipAxis: "x",
      meshClipPos: 50,
      femVectorDomainFilter: "magnetic",
      femFerromagnetVisibilityMode: "context",
    });
    const next = buildViewport3DUpdateSignature({
      topologyRevision: "topology:1",
      meshFieldRevision: "field:1",
      dataFieldRevision: "field:1",
      effectiveViewMode: "3D",
      selectedQuantity: "m",
      effectiveVectorComponent: "3D",
      meshRenderMode: "surface",
      meshClipEnabled: true,
      meshClipAxis: "x",
      meshClipPos: 50,
      femVectorDomainFilter: "magnetic",
      femFerromagnetVisibilityMode: "context",
    });

    expect(resolveViewport3DUpdateClass(first, next)).toBe("presentation_changed");
  });
});
