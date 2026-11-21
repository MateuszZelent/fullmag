import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { createViewport3DDerivedBufferCache, type Viewport3DDerivedBufferCache } from "../build-engine/cache/viewport3dDerivedBufferCache";
import type { VectorGlyphBuildResult } from "./vectorGlyphBuildScheduler";

export const VECTOR_GLYPH_DERIVED_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export const VECTOR_GLYPH_DERIVED_CACHE_MAX_ENTRIES = 12;

export interface VectorGlyphDerivedBufferRuntime {
  readonly acquire: () => {
    readonly cache: Viewport3DDerivedBufferCache<VectorGlyphBuildResult>;
    readonly release: () => void;
  };
  readonly cache: Viewport3DDerivedBufferCache<VectorGlyphBuildResult>;
}

export function createVectorGlyphDerivedBufferRuntime({
  tracker,
}: {
  readonly tracker: Viewport3DResourceTracker;
}): VectorGlyphDerivedBufferRuntime {
  const cache = createViewport3DDerivedBufferCache<VectorGlyphBuildResult>({
    maxBytes: VECTOR_GLYPH_DERIVED_CACHE_MAX_BYTES,
    maxEntries: VECTOR_GLYPH_DERIVED_CACHE_MAX_ENTRIES,
  });
  let leases = 0;
  const report = () => tracker.recordGlyphDerivedBufferCache(cache.getSnapshot());
  const unsubscribe = cache.subscribe(report);
  report();

  return {
    acquire: () => {
      leases += 1;
      let released = false;
      return {
        cache,
        release: () => {
          if (released) return;
          released = true;
          leases = Math.max(0, leases - 1);
          if (leases !== 0) return;
          cache.dispose();
          unsubscribe();
          tracker.recordGlyphDerivedBufferCache(cache.getSnapshot());
        },
      };
    },
    cache,
  };
}
