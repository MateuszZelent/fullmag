import type {
  Viewport3DBuildJobKey,
  Viewport3DBuildLane,
} from "../viewport3dBuildEngineTypes";
import { selectViewport3DCacheEvictionKeys } from "./viewport3dCacheEviction";

type Viewport3DDerivedBufferState =
  | "invalid"
  | "ready-current"
  | "stale-compatible"
  | "stale-physical";

interface Viewport3DDerivedBufferCacheEntry<TBuffer> {
  readonly buffer: TBuffer;
  readonly createdAtMs: number;
  readonly estimatedBytes: number;
  readonly fieldRevision: string | null;
  readonly groupKey: string;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly lastUsedAtMs: number;
  readonly refCount: number;
  readonly targetRevision: string | null;
  readonly topologyRevision: string | null;
}

interface Viewport3DDerivedBufferPutInput<TBuffer> {
  readonly buffer: TBuffer;
  readonly estimatedBytes: number;
  readonly fieldRevision: string | number | null;
  readonly groupKey: string;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly targetRevision: string | number | null;
  readonly topologyRevision: string | number | null;
}

interface Viewport3DDerivedBufferResolveInput {
  readonly fieldRevision: string | number | null;
  readonly groupKey: string;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly targetRevision: string | number | null;
  readonly topologyRevision: string | number | null;
}

interface Viewport3DDerivedBufferResolveResult<TBuffer> {
  readonly displayedRevision: string | null;
  readonly entry: Viewport3DDerivedBufferCacheEntry<TBuffer> | null;
  readonly state: Viewport3DDerivedBufferState;
  readonly targetRevision: string | null;
}

interface Viewport3DDerivedBufferCacheSnapshot<TBuffer> {
  readonly entries: readonly Viewport3DDerivedBufferCacheEntry<TBuffer>[];
  readonly entryCount: number;
  readonly estimatedBytes: number;
  readonly retainedBytes: number;
}

interface Viewport3DDerivedBufferEvictStaleRevisionsInput {
  readonly fieldRevision: string | number | null;
  readonly groupKey: string;
  readonly lane: Viewport3DBuildLane;
  readonly topologyRevision: string | number | null;
}

export interface Viewport3DDerivedBufferRetainHandle<TBuffer> {
  readonly entry: Viewport3DDerivedBufferCacheEntry<TBuffer>;
  readonly release: () => void;
}

export interface Viewport3DDerivedBufferCache<TBuffer> {
  readonly delete: (key: Viewport3DBuildJobKey) => boolean;
  readonly evictStaleRevisions: (
    input: Viewport3DDerivedBufferEvictStaleRevisionsInput,
  ) => Viewport3DBuildJobKey[];
  readonly evictToMaxBytes: (maxBytes: number) => Viewport3DBuildJobKey[];
  readonly get: (
    key: Viewport3DBuildJobKey,
  ) => Viewport3DDerivedBufferCacheEntry<TBuffer> | null;
  readonly getSnapshot: () => Viewport3DDerivedBufferCacheSnapshot<TBuffer>;
  readonly putReady: (input: Viewport3DDerivedBufferPutInput<TBuffer>) => void;
  readonly resolveVisible: (
    input: Viewport3DDerivedBufferResolveInput,
  ) => Viewport3DDerivedBufferResolveResult<TBuffer>;
  readonly retain: (
    key: Viewport3DBuildJobKey,
  ) => Viewport3DDerivedBufferRetainHandle<TBuffer>;
  readonly tryRetain: (
    key: Viewport3DBuildJobKey,
  ) => Viewport3DDerivedBufferRetainHandle<TBuffer> | null;
}

interface MutableViewport3DDerivedBufferCacheEntry<TBuffer> {
  buffer: TBuffer;
  createdAtMs: number;
  estimatedBytes: number;
  fieldRevision: string | null;
  groupKey: string;
  key: Viewport3DBuildJobKey;
  lane: Viewport3DBuildLane;
  lastUsedAtMs: number;
  refCount: number;
  targetRevision: string | null;
  topologyRevision: string | null;
}

export function createViewport3DDerivedBufferCache<TBuffer>({
  now = defaultNow,
}: {
  readonly now?: () => number;
} = {}): Viewport3DDerivedBufferCache<TBuffer> {
  const entries = new Map<
    Viewport3DBuildJobKey,
    MutableViewport3DDerivedBufferCacheEntry<TBuffer>
  >();

  function putReady(input: Viewport3DDerivedBufferPutInput<TBuffer>): void {
    const previous = entries.get(input.key);
    const timestampMs = now();
    entries.set(input.key, {
      buffer: input.buffer,
      createdAtMs: previous?.createdAtMs ?? timestampMs,
      estimatedBytes: normalizeByteLength(input.estimatedBytes),
      fieldRevision: normalizeRevision(input.fieldRevision),
      groupKey: input.groupKey,
      key: input.key,
      lane: input.lane,
      lastUsedAtMs: timestampMs,
      refCount: previous?.refCount ?? 0,
      targetRevision: normalizeRevision(input.targetRevision),
      topologyRevision: normalizeRevision(input.topologyRevision),
    });
  }

  function get(
    key: Viewport3DBuildJobKey,
  ): Viewport3DDerivedBufferCacheEntry<TBuffer> | null {
    const entry = entries.get(key);
    if (!entry) return null;
    entry.lastUsedAtMs = now();
    return freezeEntry(entry);
  }

  function resolveVisible({
    fieldRevision,
    groupKey,
    key,
    lane,
    targetRevision,
    topologyRevision,
  }: Viewport3DDerivedBufferResolveInput): Viewport3DDerivedBufferResolveResult<TBuffer> {
    const normalizedTargetRevision = normalizeRevision(targetRevision);
    const exact = entries.get(key);
    if (exact) {
      return {
        displayedRevision: exact.targetRevision,
        entry: freezeEntry(exact),
        state: "ready-current",
        targetRevision: normalizedTargetRevision,
      };
    }

    const previous = latestMatchingEntry(lane, groupKey);
    if (!previous) {
      return invalidResult(normalizedTargetRevision);
    }

    if (previous.topologyRevision !== normalizeRevision(topologyRevision)) {
      return invalidResult(normalizedTargetRevision);
    }

    return {
      displayedRevision: previous.targetRevision,
      entry: freezeEntry(previous),
      state:
        previous.fieldRevision === normalizeRevision(fieldRevision)
          ? "stale-compatible"
          : "stale-physical",
      targetRevision: normalizedTargetRevision,
    };
  }

  function retain(
    key: Viewport3DBuildJobKey,
  ): Viewport3DDerivedBufferRetainHandle<TBuffer> {
    const retained = tryRetain(key);
    if (!retained) {
      throw new Error(`Viewport 3D derived buffer not found: ${key}`);
    }
    return retained;
  }

  function tryRetain(
    key: Viewport3DBuildJobKey,
  ): Viewport3DDerivedBufferRetainHandle<TBuffer> | null {
    const entry = entries.get(key);
    if (!entry) return null;
    entry.refCount += 1;
    entry.lastUsedAtMs = now();
    let released = false;
    return {
      entry: freezeEntry(entry),
      release: () => {
        if (released) return;
        released = true;
        entry.refCount = Math.max(0, entry.refCount - 1);
        entry.lastUsedAtMs = now();
      },
    };
  }

  function deleteEntry(key: Viewport3DBuildJobKey): boolean {
    const entry = entries.get(key);
    if (!entry || entry.refCount > 0) return false;
    return entries.delete(key);
  }

  function evictToMaxBytes(maxBytes: number): Viewport3DBuildJobKey[] {
    const keys = selectViewport3DCacheEvictionKeys(
      Array.from(entries.values()),
      maxBytes,
    );
    const evicted: Viewport3DBuildJobKey[] = [];
    for (const key of keys) {
      if (deleteEntry(key)) evicted.push(key);
    }
    return evicted;
  }

  function evictStaleRevisions({
    fieldRevision,
    groupKey,
    lane,
    topologyRevision,
  }: Viewport3DDerivedBufferEvictStaleRevisionsInput): Viewport3DBuildJobKey[] {
    const normalizedFieldRevision = normalizeRevision(fieldRevision);
    const normalizedTopologyRevision = normalizeRevision(topologyRevision);
    const evicted: Viewport3DBuildJobKey[] = [];

    for (const entry of entries.values()) {
      if (entry.lane !== lane || entry.groupKey !== groupKey) continue;
      if (
        entry.topologyRevision === normalizedTopologyRevision &&
        entry.fieldRevision === normalizedFieldRevision
      ) {
        continue;
      }
      if (deleteEntry(entry.key)) {
        evicted.push(entry.key);
      }
    }

    return evicted;
  }

  function getSnapshot(): Viewport3DDerivedBufferCacheSnapshot<TBuffer> {
    const frozenEntries = Array.from(entries.values()).map(freezeEntry);
    return {
      entries: frozenEntries,
      entryCount: frozenEntries.length,
      estimatedBytes: frozenEntries.reduce(
        (total, entry) => total + entry.estimatedBytes,
        0,
      ),
      retainedBytes: frozenEntries.reduce(
        (total, entry) =>
          total + (entry.refCount > 0 ? entry.estimatedBytes : 0),
        0,
      ),
    };
  }

  function latestMatchingEntry(
    lane: Viewport3DBuildLane,
    groupKey: string,
  ): MutableViewport3DDerivedBufferCacheEntry<TBuffer> | null {
    let latest: MutableViewport3DDerivedBufferCacheEntry<TBuffer> | null = null;
    for (const entry of entries.values()) {
      if (entry.lane !== lane || entry.groupKey !== groupKey) continue;
      if (!latest || entry.lastUsedAtMs > latest.lastUsedAtMs) {
        latest = entry;
      }
    }
    return latest;
  }

  return {
    delete: deleteEntry,
    evictStaleRevisions,
    evictToMaxBytes,
    get,
    getSnapshot,
    putReady,
    resolveVisible,
    retain,
    tryRetain,
  };
}

function freezeEntry<TBuffer>(
  entry: MutableViewport3DDerivedBufferCacheEntry<TBuffer>,
): Viewport3DDerivedBufferCacheEntry<TBuffer> {
  return { ...entry };
}

function invalidResult<TBuffer>(
  targetRevision: string | null,
): Viewport3DDerivedBufferResolveResult<TBuffer> {
  return {
    displayedRevision: null,
    entry: null,
    state: "invalid",
    targetRevision,
  };
}

function normalizeByteLength(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeRevision(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
