import { describe, expect, it } from "vitest";

import { buildViewport3DDerivedBufferCacheKey } from "./viewport3dCacheKey";
import { createViewport3DDerivedBufferCache } from "./viewport3dDerivedBufferCache";

function key(patch: Partial<Parameters<typeof buildViewport3DDerivedBufferCacheKey>[0]> = {}) {
  return buildViewport3DDerivedBufferCacheKey({
    algorithmVersion: 1,
    groupKey: "full-vector",
    lane: "vector-glyph",
    revisionSummary: "topology=t1 field=f1 style=s1",
    ...patch,
  });
}

describe("viewport3dDerivedBufferCache", () => {
  it("returns ready-current for an exact key and tracks retained bytes", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();
    const cacheKey = key();
    const buffer = new Float32Array([1, 2, 3]);

    cache.putReady({
      buffer,
      estimatedBytes: buffer.byteLength,
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: cacheKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });

    const resolved = cache.resolveVisible({
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: cacheKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });
    expect(resolved).toMatchObject({
      displayedRevision: "field=f1",
      state: "ready-current",
      targetRevision: "field=f1",
    });
    expect(resolved.entry?.buffer).toBe(buffer);

    const handle = cache.retain(cacheKey);
    expect(cache.getSnapshot()).toMatchObject({
      estimatedBytes: buffer.byteLength,
      retainedBytes: buffer.byteLength,
    });

    handle.release();
    expect(cache.getSnapshot().retainedBytes).toBe(0);
    handle.release();
    expect(cache.getSnapshot().retainedBytes).toBe(0);
  });

  it("returns null when a cache entry disappears before effect adoption", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();
    const cacheKey = key();
    const buffer = new Float32Array([1, 2, 3]);

    expect(cache.tryRetain(cacheKey)).toBeNull();

    cache.putReady({
      buffer,
      estimatedBytes: buffer.byteLength,
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: cacheKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });

    const handle = cache.tryRetain(cacheKey);
    expect(handle?.entry.buffer).toBe(buffer);
    expect(cache.getSnapshot().retainedBytes).toBe(buffer.byteLength);

    handle?.release();
    expect(cache.getSnapshot().retainedBytes).toBe(0);
  });

  it("preserves compatible buffers as stale-compatible while a style rebuild is pending", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();
    const previousKey = key({ revisionSummary: "topology=t1 field=f1 style=s1" });
    const nextKey = key({ revisionSummary: "topology=t1 field=f1 style=s2" });
    const previous = new Float32Array([1]);

    cache.putReady({
      buffer: previous,
      estimatedBytes: previous.byteLength,
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: previousKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });

    const resolved = cache.resolveVisible({
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: nextKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });

    expect(resolved).toMatchObject({
      displayedRevision: "field=f1",
      state: "stale-compatible",
      targetRevision: "field=f1",
    });
    expect(resolved.entry?.key).toBe(previousKey);
  });

  it("marks previous field buffers as stale-physical for newer field revisions", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();
    const previousKey = key({ revisionSummary: "topology=t1 field=f1" });
    const nextKey = key({ revisionSummary: "topology=t1 field=f2" });

    cache.putReady({
      buffer: new Float32Array([1]),
      estimatedBytes: 4,
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: previousKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });

    const resolved = cache.resolveVisible({
      fieldRevision: "f2",
      groupKey: "full-vector",
      key: nextKey,
      lane: "vector-glyph",
      targetRevision: "field=f2",
      topologyRevision: "t1",
    });

    expect(resolved).toMatchObject({
      displayedRevision: "field=f1",
      state: "stale-physical",
      targetRevision: "field=f2",
    });
    expect(resolved.entry?.key).toBe(previousKey);
  });

  it("does not display buffers across incompatible topology revisions", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();

    cache.putReady({
      buffer: new Float32Array([1]),
      estimatedBytes: 4,
      fieldRevision: "f1",
      groupKey: "full-vector",
      key: key({ revisionSummary: "topology=t1 field=f1" }),
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });

    expect(
      cache.resolveVisible({
        fieldRevision: "f1",
        groupKey: "full-vector",
        key: key({ revisionSummary: "topology=t2 field=f1" }),
        lane: "vector-glyph",
        targetRevision: "field=f1",
        topologyRevision: "t2",
      }),
    ).toMatchObject({
      displayedRevision: null,
      entry: null,
      state: "invalid",
      targetRevision: "field=f1",
    });
  });

  it("evicts unretained entries but keeps retained handles until release", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();
    const retainedKey = key({ groupKey: "retained", revisionSummary: "retained" });
    const freeKey = key({ groupKey: "free", revisionSummary: "free" });

    cache.putReady({
      buffer: new Float32Array(4),
      estimatedBytes: 16,
      fieldRevision: "f1",
      groupKey: "retained",
      key: retainedKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });
    cache.putReady({
      buffer: new Float32Array(4),
      estimatedBytes: 16,
      fieldRevision: "f1",
      groupKey: "free",
      key: freeKey,
      lane: "vector-glyph",
      targetRevision: "field=f1",
      topologyRevision: "t1",
    });
    const retained = cache.retain(retainedKey);

    expect(cache.evictToMaxBytes(16)).toEqual([freeKey]);
    expect(cache.get(retainedKey)).not.toBeNull();
    expect(cache.get(freeKey)).toBeNull();

    retained.release();
    expect(cache.evictToMaxBytes(0)).toEqual([retainedKey]);
    expect(cache.getSnapshot()).toMatchObject({
      entryCount: 0,
      estimatedBytes: 0,
      retainedBytes: 0,
    });
  });

  it("evicts stale topology and field generations without releasing retained handles", () => {
    const cache = createViewport3DDerivedBufferCache<Float32Array>();
    const currentKey = key({ revisionSummary: "topology=t2 field=f2" });
    const retainedOldFieldKey = key({ revisionSummary: "topology=t2 field=f1" });
    const oldTopologyKey = key({ revisionSummary: "topology=t1 field=f1" });
    const otherGroupKey = key({
      groupKey: "other",
      revisionSummary: "topology=t1 field=f1",
    });

    for (const [entryKey, groupKey, topologyRevision, fieldRevision] of [
      [currentKey, "full-vector", "t2", "f2"],
      [retainedOldFieldKey, "full-vector", "t2", "f1"],
      [oldTopologyKey, "full-vector", "t1", "f1"],
      [otherGroupKey, "other", "t1", "f1"],
    ] as const) {
      cache.putReady({
        buffer: new Float32Array([1]),
        estimatedBytes: 4,
        fieldRevision,
        groupKey,
        key: entryKey,
        lane: "vector-glyph",
        targetRevision: `field=${fieldRevision}`,
        topologyRevision,
      });
    }

    const retained = cache.retain(retainedOldFieldKey);

    expect(
      cache.evictStaleRevisions({
        fieldRevision: "f2",
        groupKey: "full-vector",
        lane: "vector-glyph",
        topologyRevision: "t2",
      }),
    ).toEqual([oldTopologyKey]);
    expect(cache.get(currentKey)).not.toBeNull();
    expect(cache.get(retainedOldFieldKey)).not.toBeNull();
    expect(cache.get(otherGroupKey)).not.toBeNull();

    retained.release();
    expect(
      cache.evictStaleRevisions({
        fieldRevision: "f2",
        groupKey: "full-vector",
        lane: "vector-glyph",
        topologyRevision: "t2",
      }),
    ).toEqual([retainedOldFieldKey]);
  });
});
