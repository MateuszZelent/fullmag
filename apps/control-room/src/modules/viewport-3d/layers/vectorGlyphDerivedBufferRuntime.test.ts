import { describe, expect, it } from "vitest";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { createVectorGlyphDerivedBufferRuntime } from "./vectorGlyphDerivedBufferRuntime";
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
});
