import { describe, expect, it } from "vitest";

import {
  buildViewport3DFieldColorJobKey,
  buildViewport3DFdmCuboidJobKey,
  buildViewport3DRegionOverlayJobKey,
  buildViewport3DTopologyIndexJobKey,
  buildViewport3DVectorGlyphJobKey,
} from "./viewport3dBuildJobKeys";
import type { Viewport3DBuildJobKeyParts } from "./viewport3dBuildEngineTypes";

function baseKeyParts(): Viewport3DBuildJobKeyParts {
  return {
    algorithmVersion: 1,
    component: "full",
    domainId: "shared-domain",
    fieldRevision: "field-1",
    quantityId: "m",
    samplingRevision: "sampling-1",
    scopeId: "full",
    scopeKind: "full",
    sessionId: "current",
    styleRevision: "style-1",
    targetVisualizationRevision: "targets-1",
    topologyRevision: "topology-1",
  };
}

describe("viewport3dBuildJobKeys", () => {
  it("does not include camera-only revisions in heavy build keys", () => {
    const first = {
      ...baseKeyParts(),
      cameraRevision: "camera-1",
    };
    const second = {
      ...baseKeyParts(),
      cameraRevision: "camera-2",
    };

    expect(buildViewport3DTopologyIndexJobKey(first)).toBe(
      buildViewport3DTopologyIndexJobKey(second),
    );
    expect(buildViewport3DFieldColorJobKey(first)).toBe(
      buildViewport3DFieldColorJobKey(second),
    );
    expect(buildViewport3DFdmCuboidJobKey(first)).toBe(
      buildViewport3DFdmCuboidJobKey(second),
    );
    expect(buildViewport3DVectorGlyphJobKey(first)).toBe(
      buildViewport3DVectorGlyphJobKey(second),
    );
    expect(buildViewport3DRegionOverlayJobKey(first)).toBe(
      buildViewport3DRegionOverlayJobKey(second),
    );
  });

  it("keeps field-only revisions out of topology and region overlay keys", () => {
    const first = baseKeyParts();
    const second: Viewport3DBuildJobKeyParts = {
      ...first,
      fieldRevision: "field-2",
    };

    expect(buildViewport3DTopologyIndexJobKey(first)).toBe(
      buildViewport3DTopologyIndexJobKey(second),
    );
    expect(buildViewport3DRegionOverlayJobKey(first)).toBe(
      buildViewport3DRegionOverlayJobKey(second),
    );
    expect(buildViewport3DFieldColorJobKey(first)).not.toBe(
      buildViewport3DFieldColorJobKey(second),
    );
    expect(buildViewport3DFdmCuboidJobKey(first)).not.toBe(
      buildViewport3DFdmCuboidJobKey(second),
    );
    expect(buildViewport3DVectorGlyphJobKey(first)).not.toBe(
      buildViewport3DVectorGlyphJobKey(second),
    );
  });

  it("invalidates every topology-dependent lane when topology changes", () => {
    const first = baseKeyParts();
    const second: Viewport3DBuildJobKeyParts = {
      ...first,
      topologyRevision: "topology-2",
    };

    expect(buildViewport3DTopologyIndexJobKey(first)).not.toBe(
      buildViewport3DTopologyIndexJobKey(second),
    );
    expect(buildViewport3DRegionOverlayJobKey(first)).not.toBe(
      buildViewport3DRegionOverlayJobKey(second),
    );
    expect(buildViewport3DFieldColorJobKey(first)).not.toBe(
      buildViewport3DFieldColorJobKey(second),
    );
    expect(buildViewport3DFdmCuboidJobKey(first)).not.toBe(
      buildViewport3DFdmCuboidJobKey(second),
    );
    expect(buildViewport3DVectorGlyphJobKey(first)).not.toBe(
      buildViewport3DVectorGlyphJobKey(second),
    );
  });
});
