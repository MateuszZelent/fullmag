import type { FemLiveMesh } from "@/lib/session/types";
import type { FemVectorScope } from "./femVectorScopes";

export type BinaryFieldFrame = {
  key: string;
  quantityId: string;
  values: Float64Array;
  nComp: number;
  grid: [number, number, number];
};

export type ScopedBinaryFieldFrame = {
  key: string;
  quantityId: string;
  values: Float64Array;
  nComp: number;
  grid: [number, number, number];
  activeMask: boolean[] | null;
  scopes: FemVectorScope[];
};

const BINARY_FIELD_CACHE_MAX_ENTRIES = 1;
export const BINARY_FIELD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const SCOPED_BINARY_FIELD_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export interface ViewportFieldDataCacheStats {
  entries: number;
  estimatedBytes: number;
  capacity: number;
}

export interface ViewportFieldDataCacheIdentity {
  sessionId: string | null | undefined;
  runId: string | null | undefined;
  meshGenerationId: string | null | undefined;
}

const globalBinaryFieldCache = new Map<string, BinaryFieldFrame>();
const globalScopedBinaryFieldCache = new Map<string, ScopedBinaryFieldFrame>();

function cacheToken(value: string | number | null | undefined): string {
  const token = String(value ?? "none").trim();
  return token.length > 0 ? token : "none";
}

export function buildViewportFieldDataCacheKey(args: {
  identity: ViewportFieldDataCacheIdentity;
  fieldRevision: string | number | null | undefined;
  quantityId: string;
  component?: string | null;
  scopeKey?: string | null;
  nComp?: number | null;
  grid?: readonly number[] | null;
}): string {
  return [
    "viewport-field",
    cacheToken(args.identity.sessionId),
    cacheToken(args.identity.runId),
    cacheToken(args.identity.meshGenerationId),
    cacheToken(args.fieldRevision),
    cacheToken(args.quantityId),
    cacheToken(args.component ?? "full"),
    cacheToken(args.scopeKey ?? "full"),
    cacheToken(args.nComp ?? null),
    cacheToken(args.grid?.join("x") ?? null),
  ].join(":");
}

export function estimateBinaryFieldFrameBytes(frame: BinaryFieldFrame): number {
  return frame.values.byteLength + frame.key.length * 2 + frame.quantityId.length * 2 + 128;
}

export function estimateScopedBinaryFieldFrameBytes(frame: ScopedBinaryFieldFrame): number {
  const maskBytes = frame.activeMask ? frame.activeMask.length : 0;
  const scopeBytes = frame.scopes.reduce(
    (total, scope) => total + scope.kind.length * 2 + (scope.id?.length ?? 0) * 2 + 32,
    0,
  );
  return frame.values.byteLength + maskBytes + scopeBytes + frame.key.length * 2 + frame.quantityId.length * 2 + 160;
}

export function estimateBinaryFieldCacheBytes(cache: Map<string, BinaryFieldFrame>): number {
  let bytes = 0;
  for (const frame of cache.values()) {
    bytes += estimateBinaryFieldFrameBytes(frame);
  }
  return bytes;
}

export function estimateScopedBinaryFieldCacheBytes(cache: Map<string, ScopedBinaryFieldFrame>): number {
  let bytes = 0;
  for (const frame of cache.values()) {
    bytes += estimateScopedBinaryFieldFrameBytes(frame);
  }
  return bytes;
}

export function getGlobalBinaryFieldFrame(key: string): BinaryFieldFrame | null {
  const frame = globalBinaryFieldCache.get(key) ?? null;
  if (!frame) {
    return null;
  }
  globalBinaryFieldCache.delete(key);
  globalBinaryFieldCache.set(key, frame);
  return frame;
}

export function putGlobalBinaryFieldFrame(frame: BinaryFieldFrame): ViewportFieldDataCacheStats {
  globalBinaryFieldCache.set(frame.key, frame);
  return getGlobalBinaryFieldCacheStats(true);
}

export function getGlobalBinaryFieldCacheStats(prune = false): ViewportFieldDataCacheStats {
  const estimatedBytes = prune
    ? pruneBinaryFieldCache(
        globalBinaryFieldCache,
        estimateBinaryFieldFrameBytes,
        BINARY_FIELD_CACHE_MAX_BYTES,
      )
    : estimateBinaryFieldCacheBytes(globalBinaryFieldCache);
  return {
    entries: globalBinaryFieldCache.size,
    estimatedBytes,
    capacity: BINARY_FIELD_CACHE_MAX_BYTES,
  };
}

export function getGlobalScopedBinaryFieldFrame(key: string): ScopedBinaryFieldFrame | null {
  const frame = globalScopedBinaryFieldCache.get(key) ?? null;
  if (!frame) {
    return null;
  }
  globalScopedBinaryFieldCache.delete(key);
  globalScopedBinaryFieldCache.set(key, frame);
  return frame;
}

export function putGlobalScopedBinaryFieldFrame(
  frame: ScopedBinaryFieldFrame,
): ViewportFieldDataCacheStats {
  globalScopedBinaryFieldCache.set(frame.key, frame);
  return getGlobalScopedBinaryFieldCacheStats(true);
}

export function getGlobalScopedBinaryFieldCacheStats(prune = false): ViewportFieldDataCacheStats {
  const estimatedBytes = prune
    ? pruneBinaryFieldCache(
        globalScopedBinaryFieldCache,
        estimateScopedBinaryFieldFrameBytes,
        SCOPED_BINARY_FIELD_CACHE_MAX_BYTES,
      )
    : estimateScopedBinaryFieldCacheBytes(globalScopedBinaryFieldCache);
  return {
    entries: globalScopedBinaryFieldCache.size,
    estimatedBytes,
    capacity: SCOPED_BINARY_FIELD_CACHE_MAX_BYTES,
  };
}

export function clearGlobalViewportFieldDataCache(): void {
  globalBinaryFieldCache.clear();
  globalScopedBinaryFieldCache.clear();
}

export function pruneBinaryFieldCache<T>(
  cache: Map<string, T>,
  estimateFrameBytes: (frame: T) => number,
  maxBytes: number,
): number {
  let estimatedBytes = Array.from(cache.values()).reduce(
    (total, frame) => total + estimateFrameBytes(frame),
    0,
  );
  while (
    cache.size > 0 &&
    (cache.size > BINARY_FIELD_CACHE_MAX_ENTRIES || estimatedBytes > maxBytes)
  ) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) {
      break;
    }
    const evicted = cache.get(firstKey);
    cache.delete(firstKey);
    estimatedBytes -= evicted ? estimateFrameBytes(evicted) : 0;
  }
  return Math.max(0, estimatedBytes);
}

export function femVectorScopeKey(scopes: FemVectorScope[]): string {
  return scopes
    .map((scope) => `${scope.kind}:${scope.id ?? "none"}`)
    .join(",");
}

export function femMeshTransportKey(mesh: FemLiveMesh | null): string | null {
  if (!mesh) {
    return null;
  }
  if (mesh.generation_id && mesh.generation_id.length > 0) {
    return `gen:${mesh.generation_id}`;
  }
  if (mesh.mesh_id && mesh.mesh_id.length > 0) {
    return `mesh:${mesh.mesh_id}`;
  }
  return [
    "counts",
    mesh.node_count ?? mesh.nodes.length,
    mesh.element_count ?? mesh.elements.length,
    mesh.boundary_face_count ?? mesh.boundary_faces.length,
  ].join(":");
}
