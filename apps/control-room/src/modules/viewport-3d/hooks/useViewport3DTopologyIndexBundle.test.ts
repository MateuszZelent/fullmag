import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearViewport3DTopologyIndexBundleCacheForTests,
  createViewport3DTopologyIndexBuildReference,
  getViewport3DTopologyIndexBundleCacheSnapshotForTests,
  putViewport3DTopologyIndexBundleInCache,
  retainViewport3DTopologyIndexBundleFromCache,
  resolveViewport3DTopologyIndexStatus,
  TOPOLOGY_INDEX_BUNDLE_CACHE_MAX_BYTES,
  viewport3DTopologyIndexStateIsCompatible,
} from "./useViewport3DTopologyIndexBundle";
import type { Viewport3DTopologyIndexBundle } from "../viewport3dTopologyIndexModel";

const topologyIndexHookSource = readFileSync(
  new URL("./useViewport3DTopologyIndexBundle.ts", import.meta.url),
  "utf8",
);

function makeTopologyIndexBundle(seed: number): Viewport3DTopologyIndexBundle {
  return {
    airboxPartsById: new Map(),
    fallbackSurfaceEdgeIndices: Uint32Array.from([seed + 4, seed + 5]),
    fallbackSurfaceIndices: Uint32Array.from([seed, seed + 1]),
    fallbackSurfaceNodeIndices: Uint32Array.from([seed, seed + 1]),
    fallbackVolumeEdgeIndices: Uint32Array.from([seed + 2, seed + 3]),
    magneticPartsById: new Map(),
  };
}

describe("useViewport3DTopologyIndexBundle", () => {
  afterEach(() => {
    clearViewport3DTopologyIndexBundleCacheForTests();
  });

  it("creates semantic topology-index build references without field revisions", () => {
    const reference = createViewport3DTopologyIndexBuildReference({
      domainId: "shared-domain",
      sessionId: "current",
      topologyRevision: "mesh-7",
    });

    expect(reference).not.toBeNull();
    expect(reference!).toEqual({
      buildKey:
        'topology-index:{"algorithmVersion":1,"domainId":"shared-domain","lane":"topology-index","sessionId":"current","topologyRevision":"mesh-7"}',
      groupKey: "topology-index:session=current:domain=shared-domain",
      revisionSummary: "topology=mesh-7",
    });
    expect(reference!.buildKey).not.toContain("fieldRevision");
    expect(reference!.buildKey).not.toContain("targetVisualizationRevision");
  });

  it("marks topology indices as building before the worker effect resolves", () => {
    expect(
      resolveViewport3DTopologyIndexStatus({
        enabled: true,
        hasCompatibleBundle: false,
        hasCompatibleUnavailableState: false,
        hasTopology: true,
        pendingForCurrentRequest: false,
      }),
    ).toBe("building");
  });

  it("matches a built bundle only to the exact topology and part identities", () => {
    const topology = {};
    const magneticParts = {};
    const airboxParts = {};
    const magneticSurfacePartsByPartId = {};

    expect(
      viewport3DTopologyIndexStateIsCompatible(
        {
          airboxParts,
          magneticParts,
          magneticSurfacePartsByPartId,
          topology,
        },
        {
          airboxParts,
          magneticParts,
          magneticSurfacePartsByPartId,
          topology,
        },
      ),
    ).toBe(true);
    expect(
      viewport3DTopologyIndexStateIsCompatible(
        {
          airboxParts,
          magneticParts,
          magneticSurfacePartsByPartId,
          topology,
        },
        {
          airboxParts,
          magneticParts: {},
          magneticSurfacePartsByPartId,
          topology,
        },
      ),
    ).toBe(false);
  });

  it("retains cached topology index bundles by semantic build key", () => {
    const bundle = makeTopologyIndexBundle(0);
    const handle = putViewport3DTopologyIndexBundleInCache({
      bundle,
      key: "topology-index:topology=mesh-7:targets=targets-4",
    });

    expect(handle.bundle).toBe(bundle);
    expect(
      getViewport3DTopologyIndexBundleCacheSnapshotForTests(),
    ).toMatchObject({
      entryCount: 1,
      retainedEntries: 1,
    });

    const retained = retainViewport3DTopologyIndexBundleFromCache(
      "topology-index:topology=mesh-7:targets=targets-4",
    );
    expect(retained?.bundle).toBe(bundle);

    retained?.release();
    handle.release();
    expect(
      getViewport3DTopologyIndexBundleCacheSnapshotForTests(),
    ).toMatchObject({
      entryCount: 1,
      retainedEntries: 0,
    });
  });

  it("accounts for aligned surface cell identity buffers in cache memory", () => {
    const bundle = makeTopologyIndexBundle(0);
    bundle.magneticPartsById.set("film", {
      edgeIndices: null,
      surfaceIndices: null,
      surfaceNodeIndices: null,
      surfaceNodeSelection: null,
      surfaceTriangleCellTypes: new Uint32Array([2, 2]),
      surfaceTriangleFacetIndices: null,
      surfaceTriangleGlobalCellOrdinals: new BigUint64Array([BigInt(7), BigInt(7)]),
      volumeEdgeIndices: null,
    });
    const handle = putViewport3DTopologyIndexBundleInCache({
      bundle,
      key: "topology-index:identity-memory",
    });

    expect(
      getViewport3DTopologyIndexBundleCacheSnapshotForTests().estimatedBytes,
    ).toBe(56);
    handle.release();
  });

  it("uses semantic cache handles instead of storing topology bundles in React state", () => {
    const reducerStateSource = topologyIndexHookSource.slice(
      topologyIndexHookSource.indexOf("interface Viewport3DTopologyIndexReducerState"),
      topologyIndexHookSource.indexOf("type Viewport3DTopologyIndexAction"),
    );

    expect(topologyIndexHookSource).toContain(
      "retainViewport3DTopologyIndexBundleFromCache",
    );
    expect(topologyIndexHookSource).toContain(
      "putViewport3DTopologyIndexBundleInCache",
    );
    expect(topologyIndexHookSource).toContain(
      "topologyIndexBundleBuffers.get(state.token)",
    );
    expect(reducerStateSource).not.toContain(
      "bundle: Viewport3DTopologyIndexBundle | null;",
    );
    expect(reducerStateSource).toContain("token: object | null;");
  });

  it("evicts old unretained topology index bundles while preserving retained visible entries", () => {
    const retained = putViewport3DTopologyIndexBundleInCache({
      bundle: makeTopologyIndexBundle(0),
      key: "topology-index:retained",
    });

    for (let index = 0; index < 24; index += 1) {
      putViewport3DTopologyIndexBundleInCache({
        bundle: makeTopologyIndexBundle(index),
        key: `topology-index:free:${index}`,
      }).release();
    }

    const snapshot = getViewport3DTopologyIndexBundleCacheSnapshotForTests();
    expect(snapshot.entryCount).toBeLessThanOrEqual(16);
    expect(snapshot.keys).toContain("topology-index:retained");
    expect(
      retainViewport3DTopologyIndexBundleFromCache("topology-index:retained")
        ?.bundle,
    ).toBe(retained.bundle);
    retained.release();
  });

  it("evicts unretained topology bundles when typed arrays exceed the byte budget", () => {
    const indicesPerEntry =
      Math.floor(TOPOLOGY_INDEX_BUNDLE_CACHE_MAX_BYTES / Uint32Array.BYTES_PER_ELEMENT / 2) +
      1;

    for (let index = 0; index < 2; index += 1) {
      putViewport3DTopologyIndexBundleInCache({
        bundle: {
          ...makeTopologyIndexBundle(index),
          fallbackSurfaceIndices: new Uint32Array(indicesPerEntry),
        },
        key: `topology-index:large:${index}`,
      }).release();
    }

    const snapshot = getViewport3DTopologyIndexBundleCacheSnapshotForTests();
    expect(snapshot.entryCount).toBe(1);
    expect(snapshot.estimatedBytes).toBeLessThanOrEqual(
      TOPOLOGY_INDEX_BUNDLE_CACHE_MAX_BYTES,
    );
    expect(snapshot.keys).toEqual(["topology-index:large:1"]);
  });
});
