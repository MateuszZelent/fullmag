"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import {
  createViewport3DDerivedBufferCache,
  type Viewport3DDerivedBufferCache,
} from "../build-engine/cache/viewport3dDerivedBufferCache";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
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

const VectorGlyphDerivedBufferCacheContext =
  createContext<Viewport3DDerivedBufferCache<VectorGlyphBuildResult> | null>(null);

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

export function VectorGlyphDerivedBufferCacheProvider({
  children,
  tracker,
}: {
  readonly children: ReactNode;
  readonly tracker: Viewport3DResourceTracker;
}) {
  const runtime = useMemo(() => createVectorGlyphDerivedBufferRuntime({ tracker }), [tracker]);
  const lease = useMemo(() => runtime.acquire(), [runtime]);

  useEffect(() => () => lease.release(), [lease]);

  return (
    <VectorGlyphDerivedBufferCacheContext.Provider value={lease.cache}>
      {children}
    </VectorGlyphDerivedBufferCacheContext.Provider>
  );
}

export function useVectorGlyphDerivedBufferCache(): Viewport3DDerivedBufferCache<VectorGlyphBuildResult> {
  const cache = useContext(VectorGlyphDerivedBufferCacheContext);
  if (!cache) {
    throw new Error("Vector glyph derived-buffer cache requires a viewport runtime");
  }
  return cache;
}
