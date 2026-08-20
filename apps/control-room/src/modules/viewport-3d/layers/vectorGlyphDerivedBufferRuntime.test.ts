import { describe, expect, it } from "vitest";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  VECTOR_GLYPH_DERIVED_CACHE_MAX_BYTES,
  VECTOR_GLYPH_DERIVED_CACHE_MAX_ENTRIES,
  createVectorGlyphDerivedBufferRuntime,
} from "./vectorGlyphDerivedBufferRuntime";
import { buildViewport3DDerivedBufferCacheKey } from "../build-engine/cache/viewport3dCacheKey";

const key = buildViewport3DDerivedBufferCacheKey({
  algorithmVersion: 1,
  groupKey: "vector:part-a",
  lane: "vector-glyph",
  revisionSummary: "glyph-a",
});

const result = {
  colors: null,
  transforms: {
    count: 0,
    directions: new Float32Array(),
    headCenters: new Float32Array(),
    headScales: new Float32Array(),
    shaftCenters: new Float32Array(),
    shaftScales: new Float32Array(),
  },
};

describe("vectorGlyphDerivedBufferRuntime", () => {
  it("shares one bounded cache across consumers and disposes it with the last viewport lease", () => {
    const tracker = new Viewport3DResourceTracker();
    const runtime = createVectorGlyphDerivedBufferRuntime({ tracker });
    const firstViewport = runtime.acquire();
    const secondViewport = runtime.acquire();

    expect(firstViewport.cache).toBe(secondViewport.cache);
    firstViewport.cache.putReady({
      buffer: result,
      estimatedBytes: 16,
      fieldRevision: "f1",
      groupKey: "vector:part-a",
      key,
      lane: "vector-glyph",
      targetRevision: "f1",
      topologyRevision: "t1",
    });

    expect(tracker.getSnapshot()).toMatchObject({
      glyphCacheBytes: 16,
      glyphCacheEntries: 1,
      glyphCacheRetainedBytes: 0,
    });
    firstViewport.release();
    expect(firstViewport.cache.getSnapshot().entryCount).toBe(1);
    secondViewport.release();
    expect(firstViewport.cache.getSnapshot()).toMatchObject({
      entryCount: 0,
      estimatedBytes: 0,
      retainedBytes: 0,
    });
    expect(tracker.getSnapshot()).toMatchObject({
      glyphCacheBytes: 0,
      glyphCacheEntries: 0,
      glyphCacheRetainedBytes: 0,
    });
  });

  it("enforces the production glyph byte budget through the viewport runtime owner", () => {
    const tracker = new Viewport3DResourceTracker();
    const runtime = createVectorGlyphDerivedBufferRuntime({ tracker });
    const viewport = runtime.acquire();
    const estimatedBytes = Math.floor(VECTOR_GLYPH_DERIVED_CACHE_MAX_BYTES / 2) + 1;
    const firstKey = buildViewport3DDerivedBufferCacheKey({
      algorithmVersion: 1,
      groupKey: "vector:budget-a",
      lane: "vector-glyph",
      revisionSummary: "glyph-budget-a",
    });
    const secondKey = buildViewport3DDerivedBufferCacheKey({
      algorithmVersion: 1,
      groupKey: "vector:budget-b",
      lane: "vector-glyph",
      revisionSummary: "glyph-budget-b",
    });

    for (const [cacheKey, groupKey, revision] of [
      [firstKey, "vector:budget-a", "f1"],
      [secondKey, "vector:budget-b", "f2"],
    ] as const) {
      viewport.cache.putReady({
        buffer: result,
        estimatedBytes,
        fieldRevision: revision,
        groupKey,
        key: cacheKey,
        lane: "vector-glyph",
        targetRevision: revision,
        topologyRevision: "t1",
      });
    }

    expect(viewport.cache.getSnapshot()).toMatchObject({
      entryCount: 1,
      estimatedBytes,
    });
    expect(viewport.cache.getSnapshot().entryCount).toBeLessThanOrEqual(
      VECTOR_GLYPH_DERIVED_CACHE_MAX_ENTRIES,
    );
    expect(viewport.cache.getSnapshot().estimatedBytes).toBeLessThanOrEqual(
      VECTOR_GLYPH_DERIVED_CACHE_MAX_BYTES,
    );
    expect(tracker.getSnapshot()).toMatchObject({
      glyphCacheBytes: estimatedBytes,
      glyphCacheEntries: 1,
    });

    viewport.release();
  });
});
