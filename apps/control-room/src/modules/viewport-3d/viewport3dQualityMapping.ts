import type {
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import { magnitudeColorRgb } from "./viewport3dVectorColoring";

export type MeshQualityColorMetric = "gamma" | "sicn" | "volume";

type MeshQualityColorCacheEntry = Partial<
  Record<string, ScalarColorBuffer | null>
>;

const MESH_QUALITY_COLOR_CACHE_MAX_ENTRIES_PER_QUALITY = 8;
const MESH_QUALITY_COLOR_CACHE_MEMORY_BUDGET_ID =
  "viewport3d.render.meshQualityColorCache";
const meshQualityColorCacheCounter = {
  byteLength: 0,
  entryCount: 0,
};

memoryBudgetRegistry.register(
  MESH_QUALITY_COLOR_CACHE_MEMORY_BUDGET_ID,
  () => ({
    byteLength: meshQualityColorCacheCounter.byteLength,
    category: "render-buffer",
    entryCount: meshQualityColorCacheCounter.entryCount,
    id: MESH_QUALITY_COLOR_CACHE_MEMORY_BUDGET_ID,
    label: "Mesh quality color cache",
    maxBytes: null,
  }),
);

const meshQualityVertexColorCache = new WeakMap<
  DecodedTopology,
  WeakMap<DecodedMeshQualityData, MeshQualityColorCacheEntry>
>();

export function buildMeshQualityVertexColors(
  topology: DecodedTopology | null | undefined,
  quality: DecodedMeshQualityData | null | undefined,
  metric: MeshQualityColorMetric,
  palette = "viridis",
): ScalarColorBuffer | null {
  if (!topology || !quality) return null;

  const cacheKey = `${metric}:${palette}`;
  const cached = cachedMeshQualityVertexColors(topology, quality, cacheKey);
  if (cached !== undefined) return cached;

  if (quality.elementCount !== topology.elementCount) {
    cacheMeshQualityVertexColors(topology, quality, cacheKey, null);
    return null;
  }

  const values = quality[metric];
  if (!values || values.length !== topology.elementCount) {
    cacheMeshQualityVertexColors(topology, quality, cacheKey, null);
    return null;
  }
  if (topology.indices.length !== topology.elementCount * 4) {
    cacheMeshQualityVertexColors(topology, quality, cacheKey, null);
    return null;
  }

  const range = rangeFor(values);
  if (!range) {
    cacheMeshQualityVertexColors(topology, quality, cacheKey, null);
    return null;
  }

  const sums = new Float64Array(topology.nodeCount);
  const counts = new Uint32Array(topology.nodeCount);
  for (let element = 0; element < topology.elementCount; element += 1) {
    const value = values[element] ?? 0;
    const offset = element * 4;
    for (let corner = 0; corner < 4; corner += 1) {
      const node = topology.indices[offset + corner];
      if (node === undefined || node >= topology.nodeCount) return null;
      sums[node] += value;
      counts[node] += 1;
    }
  }

  const colors = new Float32Array(topology.nodeCount * 3);
  for (let node = 0; node < topology.nodeCount; node += 1) {
    const value = counts[node] > 0 ? sums[node] / counts[node] : range.min;
    const [red, green, blue] = magnitudeColorRgb(normalize(value, range), palette);
    const target = node * 3;
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
  }

  const result = { colors, range };
  cacheMeshQualityVertexColors(topology, quality, cacheKey, result);
  return result;
}

function cachedMeshQualityVertexColors(
  topology: DecodedTopology,
  quality: DecodedMeshQualityData,
  cacheKey: string,
): ScalarColorBuffer | null | undefined {
  const byQuality = meshQualityVertexColorCache.get(topology);
  if (!byQuality) return undefined;
  const entry = byQuality.get(quality);
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, cacheKey)) {
    return undefined;
  }
  return entry[cacheKey] ?? null;
}

function cacheMeshQualityVertexColors(
  topology: DecodedTopology,
  quality: DecodedMeshQualityData,
  cacheKey: string,
  result: ScalarColorBuffer | null,
): void {
  let byQuality = meshQualityVertexColorCache.get(topology);
  if (!byQuality) {
    byQuality = new WeakMap();
    meshQualityVertexColorCache.set(topology, byQuality);
  }
  const entry = byQuality.get(quality) ?? {};
  entry[cacheKey] = result;
  meshQualityColorCacheCounter.entryCount += 1;
  meshQualityColorCacheCounter.byteLength += meshQualityColorByteLength(result);
  evictOldestMeshQualityColorCacheEntries(entry);
  byQuality.set(quality, entry);
}

function evictOldestMeshQualityColorCacheEntries(
  entry: MeshQualityColorCacheEntry,
): void {
  const keys = Object.keys(entry);
  while (keys.length > MESH_QUALITY_COLOR_CACHE_MAX_ENTRIES_PER_QUALITY) {
    const oldestKey = keys.shift();
    if (!oldestKey) return;
    const value = entry[oldestKey];
    delete entry[oldestKey];
    meshQualityColorCacheCounter.entryCount = Math.max(
      0,
      meshQualityColorCacheCounter.entryCount - 1,
    );
    meshQualityColorCacheCounter.byteLength = Math.max(
      0,
      meshQualityColorCacheCounter.byteLength -
        meshQualityColorByteLength(value),
    );
  }
}

function meshQualityColorByteLength(
  result: ScalarColorBuffer | null | undefined,
): number {
  return (
    (result?.colors.byteLength ?? 0) +
    (result?.scalarValues?.byteLength ?? 0) +
    (result?.vectorValues?.byteLength ?? 0) +
    (result?.complexRealValues?.byteLength ?? 0) +
    (result?.complexImagValues?.byteLength ?? 0)
  );
}

function rangeFor(values: Float64Array): { max: number; min: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) return null;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { max, min };
}

function normalize(
  value: number,
  range: { max: number; min: number },
): number {
  const span = Math.max(range.max - range.min, 1e-12);
  return Math.min(Math.max((value - range.min) / span, 0), 1);
}
