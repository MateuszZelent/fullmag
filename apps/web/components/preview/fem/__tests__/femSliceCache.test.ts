import { describe, expect, it } from "vitest";

import {
  fieldCacheKey,
  getSliceCacheSnapshot,
  getSliceFieldCached,
  getSliceTopologyCached,
  readSliceFieldCache,
  readSliceTopologyCache,
  topologyCacheKey,
} from "../femSliceCache";
import type { FemSliceQuery } from "../femSliceQuery";
import type { SliceCollection, SliceTopologyCollection } from "../femSliceGeometry";

function makeQuery(overrides: Partial<FemSliceQuery> = {}): FemSliceQuery {
  return {
    orientation: "xy",
    positionMode: "sync_3d_clip",
    planeOffset: 50,
    thicknessMode: "exact",
    thicknessWorld: 0,
    aggregation: "sample",
    quantityId: "m",
    component: "x",
    vectorMode: "in_plane",
    scope: "visible",
    extentMode: "fit_visible",
    colorScaleMode: "slice_auto",
    ...overrides,
  };
}

function makeTopology(seed: number): SliceTopologyCollection {
  return {
    planeCoord: seed,
    normalLabel: "z",
    uLabel: "x",
    vLabel: "y",
    bounds: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
    segments: [],
    polygons: [],
  };
}

function makeSlice(seed: number): SliceCollection {
  return {
    planeCoord: seed,
    normalLabel: "z",
    uLabel: "x",
    vLabel: "y",
    bounds: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
    segments: [],
    polygons: [],
    arrows: [],
    valueRange: { min: 0, max: 1 },
  };
}

describe("femSliceCache", () => {
  it("builds deterministic topology and field keys", () => {
    const query = makeQuery();
    const context = {
      planeWorldCoord: 0.125,
      boundsStrategy: "visible-context",
      visiblePartIds: ["a", "b"],
    };
    const key1 = topologyCacheKey(query, context);
    const key2 = topologyCacheKey(query, context);
    const field1 = fieldCacheKey(query, context);
    const field2 = fieldCacheKey(makeQuery({ component: "y" }), context);

    expect(key1).toBe(key2);
    expect(field1).not.toBe(field2);
  });

  it("returns miss then hit for topology and field cache", () => {
    const keyPrefix = `cache-test-${Date.now()}`;
    let topologyComputes = 0;
    let fieldComputes = 0;

    const top1 = getSliceTopologyCached(`${keyPrefix}:topology`, () => {
      topologyComputes += 1;
      return makeTopology(1);
    });
    const top2 = getSliceTopologyCached(`${keyPrefix}:topology`, () => {
      topologyComputes += 1;
      return makeTopology(2);
    });
    const field1 = getSliceFieldCached(`${keyPrefix}:field`, () => {
      fieldComputes += 1;
      return makeSlice(1);
    });
    const field2 = getSliceFieldCached(`${keyPrefix}:field`, () => {
      fieldComputes += 1;
      return makeSlice(2);
    });

    expect(top1.cacheState).toBe("miss");
    expect(top2.cacheState).toBe("hit");
    expect(topologyComputes).toBe(1);
    expect(top2.value).toBe(top1.value);
    expect(readSliceTopologyCache(`${keyPrefix}:topology`)).toBe(top1.value);

    expect(field1.cacheState).toBe("miss");
    expect(field2.cacheState).toBe("hit");
    expect(fieldComputes).toBe(1);
    expect(field2.value).toBe(field1.value);
    expect(readSliceFieldCache(`${keyPrefix}:field`)).toBe(field1.value);
  });

  it("evicts old entries when cache exceeds capacity", () => {
    const snapshotBefore = getSliceCacheSnapshot();
    const seed = `evict-${Date.now()}`;

    for (let i = 0; i < snapshotBefore.topologyCapacity + 5; i += 1) {
      getSliceTopologyCached(`${seed}:topology:${i}`, () => makeTopology(i));
    }
    for (let i = 0; i < snapshotBefore.fieldCapacity + 5; i += 1) {
      getSliceFieldCached(`${seed}:field:${i}`, () => makeSlice(i));
    }

    const snapshotAfter = getSliceCacheSnapshot();
    expect(snapshotAfter.topologyEntries).toBeLessThanOrEqual(snapshotAfter.topologyCapacity);
    expect(snapshotAfter.fieldEntries).toBeLessThanOrEqual(snapshotAfter.fieldCapacity);
    expect(readSliceTopologyCache(`${seed}:topology:0`)).toBeNull();
    expect(readSliceFieldCache(`${seed}:field:0`)).toBeNull();
  });
});
