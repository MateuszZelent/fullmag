"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { type Viewport3DDerivedBufferCache } from "../build-engine/cache/viewport3dDerivedBufferCache";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { VectorGlyphBuildResult } from "./vectorGlyphBuildScheduler";
import { createVectorGlyphDerivedBufferRuntime } from "./vectorGlyphDerivedBufferRuntime.model";

const VectorGlyphDerivedBufferCacheContext =
  createContext<Viewport3DDerivedBufferCache<VectorGlyphBuildResult> | null>(null);

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
