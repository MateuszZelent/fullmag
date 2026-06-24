import { afterEach, describe, expect, it } from "vitest";

import {
  clearViewport3DRegionOverlayModelCacheForTests,
  createViewport3DRegionOverlayBuildReference,
  getViewport3DRegionOverlayModelCacheSnapshotForTests,
  putViewport3DRegionOverlayModelsInCache,
  retainViewport3DRegionOverlayModelsFromCache,
  resolveViewport3DRegionOverlayBuildStatus,
  viewport3DRegionOverlayIdentityIsCompatible,
  viewport3DRegionOverlayTopologyIdentityIsCompatible,
} from "./useViewport3DRegionOverlayModels";

describe("useViewport3DRegionOverlayModels", () => {
  afterEach(() => {
    clearViewport3DRegionOverlayModelCacheForTests();
  });

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

  it("keeps topology-compatible stale overlays during style-only rebuilds", () => {
    const topology = {};
    const magneticParts = {};
    const regions = {};
    const renderedSurfacePartIds = {};

    expect(
      viewport3DRegionOverlayTopologyIdentityIsCompatible(
        {
          magneticParts,
          regions,
          renderedSurfacePartIds,
          selectedObjectId: "film",
          selectedRegionId: "film:core",
          settingsByRegionId: {},
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          renderedSurfacePartIds,
          selectedObjectId: null,
          selectedRegionId: null,
          settingsByRegionId: {},
          theme: "latte",
          topology,
        },
      ),
    ).toBe(true);
    expect(
      viewport3DRegionOverlayTopologyIdentityIsCompatible(
        {
          magneticParts,
          regions,
          renderedSurfacePartIds,
          selectedObjectId: null,
          selectedRegionId: null,
          settingsByRegionId: null,
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          renderedSurfacePartIds,
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

  it("retains cached region overlay models by semantic build key", () => {
    const models = [
      {
        edgeIndices: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
        surfaceEdgeIndices: null,
        surfaceIndices: Uint32Array.from([0, 1]),
      } as never,
    ];
    const handle = putViewport3DRegionOverlayModelsInCache({
      key: "region-overlay:topology=mesh-7:regions=film-core:display=realized",
      models,
    });

    expect(handle.models).toBe(models);
    expect(getViewport3DRegionOverlayModelCacheSnapshotForTests()).toMatchObject({
      entryCount: 1,
      retainedEntries: 1,
    });

    const retained = retainViewport3DRegionOverlayModelsFromCache(
      "region-overlay:topology=mesh-7:regions=film-core:display=realized",
    );
    expect(retained?.models).toBe(models);

    retained?.release();
    handle.release();
    expect(getViewport3DRegionOverlayModelCacheSnapshotForTests()).toMatchObject({
      entryCount: 1,
      retainedEntries: 0,
    });
  });

  it("evicts old unretained cached overlays while preserving retained visible entries", () => {
    const retained = putViewport3DRegionOverlayModelsInCache({
      key: "region-overlay:retained",
      models: [{ positions: new Float32Array([0, 0, 0]) } as never],
    });

    for (let index = 0; index < 24; index += 1) {
      putViewport3DRegionOverlayModelsInCache({
        key: `region-overlay:free:${index}`,
        models: [{ positions: new Float32Array([index, 0, 0]) } as never],
      }).release();
    }

    const snapshot = getViewport3DRegionOverlayModelCacheSnapshotForTests();
    expect(snapshot.entryCount).toBeLessThanOrEqual(16);
    expect(snapshot.keys).toContain("region-overlay:retained");
    expect(
      retainViewport3DRegionOverlayModelsFromCache("region-overlay:retained")
        ?.models,
    ).toBe(retained.models);
    retained.release();
  });
});
