import { describe, expect, it } from "vitest";

import {
  createViewport3DRegionOverlayBuildReference,
  resolveViewport3DRegionOverlayBuildStatus,
  viewport3DRegionOverlayIdentityIsCompatible,
} from "./useViewport3DRegionOverlayModels";

describe("useViewport3DRegionOverlayModels", () => {
  it("creates semantic region-overlay build references without field revisions", () => {
    const reference = createViewport3DRegionOverlayBuildReference({
      domainId: "shared-domain",
      regionSignature: "film:core|part:film:core",
      sessionId: "current",
      targetVisualizationRevision: "targets-4",
      topologyRevision: "mesh-7",
    });

    expect(reference).not.toBeNull();
    expect(reference!).toEqual({
      buildKey:
        'region-overlay:{"algorithmVersion":1,"domainId":"shared-domain","lane":"region-overlay","sessionId":"current","styleRevision":"regions=film:core|part:film:core","targetVisualizationRevision":"targets-4","topologyRevision":"mesh-7"}',
      groupKey: "region-overlay:session=current:domain=shared-domain",
      revisionSummary:
        "topology=mesh-7 targets=targets-4 regions=film:core|part:film:core",
    });
    expect(reference!.buildKey).not.toContain("fieldRevision");
  });

  it("keeps stale models visible only when the topology identity is unchanged", () => {
    const topology = {};
    const magneticParts = {};
    const regions = {};

    expect(
      viewport3DRegionOverlayIdentityIsCompatible(
        {
          magneticParts,
          regions,
          renderedSurfacePartIds: null,
          selectedObjectId: null,
          selectedRegionId: null,
          settingsByRegionId: null,
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          renderedSurfacePartIds: null,
          selectedObjectId: null,
          selectedRegionId: null,
          settingsByRegionId: null,
          theme: "mocha",
          topology,
        },
      ),
    ).toBe(true);
    expect(
      viewport3DRegionOverlayIdentityIsCompatible(
        {
          magneticParts,
          regions,
          renderedSurfacePartIds: null,
          selectedObjectId: null,
          selectedRegionId: null,
          settingsByRegionId: null,
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          renderedSurfacePartIds: null,
          selectedObjectId: null,
          selectedRegionId: null,
          settingsByRegionId: null,
          theme: "mocha",
          topology: {},
        },
      ),
    ).toBe(false);
  });

  it("reports stale-visible while compatible models remain visible during a rebuild", () => {
    expect(
      resolveViewport3DRegionOverlayBuildStatus({
        enabled: true,
        hasCompatibleModels: false,
        hasCompatibleTopologyModels: true,
        hasCompatibleUnavailableState: false,
        hasTopology: true,
        pendingForCurrentRequest: true,
      }),
    ).toBe("stale-visible");
  });
});
