import { afterEach, describe, expect, it } from "vitest";

import {
  clearViewport3DRegionOverlayModelCacheForTests,
  createViewport3DRegionOverlayBuildReference,
  getViewport3DRegionOverlayModelCacheSnapshotForTests,
  putViewport3DRegionOverlayModelsInCache,
  REGION_OVERLAY_MODEL_CACHE_MAX_BYTES,
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
      topologyRevision: "mesh-7",
    });

    expect(reference).not.toBeNull();
    expect(reference!).toEqual({
      buildKey:
        'region-overlay:{"algorithmVersion":1,"domainId":"shared-domain","lane":"region-overlay","sessionId":"current","styleRevision":"regions=film:core|part:film:core","targetVisualizationRevision":"region-signature","topologyRevision":"mesh-7"}',
      groupKey: "region-overlay:session=current:domain=shared-domain",
      revisionSummary:
        "topology=mesh-7 regions=film:core|part:film:core",
    });
    expect(reference!.buildKey).not.toContain("fieldRevision");
  });

  it("does not invalidate region geometry for unrelated target visualization revisions", () => {
    const first = createViewport3DRegionOverlayBuildReference({
      domainId: "shared-domain",
      regionSignature: "film:core|part:film:core",
      sessionId: "current",
      topologyRevision: "mesh-7",
    });
    const second = createViewport3DRegionOverlayBuildReference({
      domainId: "shared-domain",
      regionSignature: "film:core|part:film:core",
      sessionId: "current",
      topologyRevision: "mesh-7",
    });

    expect(second?.buildKey).toBe(first?.buildKey);
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
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
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
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
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

    expect(
      viewport3DRegionOverlayTopologyIdentityIsCompatible(
        {
          magneticParts,
          regions,
          selectedObjectId: "film",
          selectedRegionId: "film:core",
          regionSignature: "selected-film",
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
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
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
          theme: "mocha",
          topology,
        },
        {
          magneticParts,
          regions,
          selectedObjectId: null,
          selectedRegionId: null,
          regionSignature: "default",
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

  it("evicts unretained overlays when their typed-array memory exceeds the byte budget", () => {
    const floatsPerEntry =
      Math.floor(REGION_OVERLAY_MODEL_CACHE_MAX_BYTES / Float32Array.BYTES_PER_ELEMENT / 2) +
      1;

    for (let index = 0; index < 2; index += 1) {
      putViewport3DRegionOverlayModelsInCache({
        key: `region-overlay:large:${index}`,
        models: [
          { positions: new Float32Array(floatsPerEntry) } as never,
        ],
      }).release();
    }

    const snapshot = getViewport3DRegionOverlayModelCacheSnapshotForTests();
    expect(snapshot.entryCount).toBe(1);
    expect(snapshot.estimatedBytes).toBeLessThanOrEqual(
      REGION_OVERLAY_MODEL_CACHE_MAX_BYTES,
    );
    expect(snapshot.keys).toEqual(["region-overlay:large:1"]);
  });
});
