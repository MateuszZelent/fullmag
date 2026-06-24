import type { Viewport3DBuildJobKey } from "../viewport3dBuildEngineTypes";

export interface Viewport3DCacheEvictionEntry {
  readonly estimatedBytes: number;
  readonly key: Viewport3DBuildJobKey;
  readonly lastUsedAtMs: number;
  readonly refCount: number;
}

export function selectViewport3DCacheEvictionKeys(
  entries: readonly Viewport3DCacheEvictionEntry[],
  maxBytes: number,
): Viewport3DBuildJobKey[] {
  const safeMaxBytes = Math.max(0, Math.trunc(maxBytes));
  let totalBytes = entries.reduce(
    (total, entry) => total + Math.max(0, entry.estimatedBytes),
    0,
  );
  if (totalBytes <= safeMaxBytes) return [];

  const evictable = entries
    .filter((entry) => entry.refCount <= 0)
    .toSorted((left, right) => left.lastUsedAtMs - right.lastUsedAtMs);
  const keys: Viewport3DBuildJobKey[] = [];

  for (const entry of evictable) {
    if (totalBytes <= safeMaxBytes) break;
    keys.push(entry.key);
    totalBytes -= Math.max(0, entry.estimatedBytes);
  }

  return keys;
}
