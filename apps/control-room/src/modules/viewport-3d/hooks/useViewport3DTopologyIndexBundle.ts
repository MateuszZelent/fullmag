"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DecodedTopology } from "@/kernel/api/codecs";

import { buildViewport3DTopologyIndexJobKey } from "../build-engine/viewport3dBuildJobKeys";
import {
  buildViewport3DTopologyIndicesOffMainThread,
  type Viewport3DTopologyIndexBuildRequest,
} from "../viewport3dTopologyIndexScheduler";
import type {
  Viewport3DTopologyIndexBundle,
  Viewport3DTopologyIndexPartInput,
} from "../viewport3dTopologyIndexModel";

export type Viewport3DTopologyIndexBuildStatus =
  | "building"
  | "idle"
  | "ready"
  | "unavailable";

export interface Viewport3DTopologyIndexIdentity {
  airboxParts: object;
  magneticParts: object;
  magneticSurfacePartsByPartId: object;
  topology: object;
}

export interface Viewport3DTopologyIndexBuildReference {
  buildKey: string;
  groupKey: string;
  revisionSummary: string;
}

export interface Viewport3DTopologyIndexBuildReferenceInput {
  domainId: string;
  sessionId: string;
  topologyRevision: string | null;
}

interface Viewport3DTopologyIndexReducerState {
  identity: Viewport3DTopologyIndexIdentity | null;
  pending: boolean;
  token: object | null;
  unavailable: boolean;
}

type Viewport3DTopologyIndexAction =
  | { type: "clear" }
  | { identity: Viewport3DTopologyIndexIdentity; type: "start" }
  | {
      identity: Viewport3DTopologyIndexIdentity;
      token: object;
      type: "success";
    }
  | { identity: Viewport3DTopologyIndexIdentity; type: "unavailable" };

export interface Viewport3DTopologyIndexBundleResult {
  bundle: Viewport3DTopologyIndexBundle | null;
  status: Viewport3DTopologyIndexBuildStatus;
}

export interface Viewport3DTopologyIndexBundleCacheHandle {
  bundle: Viewport3DTopologyIndexBundle;
  release: () => void;
  token: object;
}

export interface Viewport3DTopologyIndexBundleCacheSnapshot {
  entryCount: number;
  estimatedBytes: number;
  keys: readonly string[];
  retainedEntries: number;
}

interface Viewport3DTopologyIndexBundleCacheEntry {
  bundle: Viewport3DTopologyIndexBundle;
  estimatedBytes: number;
  key: string;
  lastUsedAtMs: number;
  refCount: number;
  token: object;
}

const TOPOLOGY_INDEX_BUNDLE_CACHE_LIMIT = 16;
const VIEWPORT_3D_TOPOLOGY_INDEX_INITIAL_STATE: Viewport3DTopologyIndexReducerState =
  {
    identity: null,
    pending: false,
    token: null,
    unavailable: false,
  };
const topologyIndexBundleBuffers = new WeakMap<
  object,
  Viewport3DTopologyIndexBundle
>();
const topologyIndexBundleCache = new Map<
  string,
  Viewport3DTopologyIndexBundleCacheEntry
>();

export function createViewport3DTopologyIndexBuildReference({
  domainId,
  sessionId,
  topologyRevision,
}: Viewport3DTopologyIndexBuildReferenceInput): Viewport3DTopologyIndexBuildReference | null {
  if (!topologyRevision) return null;
  return {
    buildKey: buildViewport3DTopologyIndexJobKey({
      algorithmVersion: 1,
      component: null,
      domainId,
      fieldRevision: null,
      quantityId: null,
      samplingRevision: "none",
      scopeId: null,
      scopeKind: null,
      sessionId,
      styleRevision: "none",
      targetVisualizationRevision: "none",
      topologyRevision,
    }),
    groupKey: `topology-index:session=${sessionId}:domain=${domainId}`,
    revisionSummary: `topology=${topologyRevision}`,
  };
}

function viewport3DTopologyIndexReducer(
  _state: Viewport3DTopologyIndexReducerState,
  action: Viewport3DTopologyIndexAction,
): Viewport3DTopologyIndexReducerState {
  switch (action.type) {
    case "clear":
      return VIEWPORT_3D_TOPOLOGY_INDEX_INITIAL_STATE;
    case "start":
      return {
        identity: action.identity,
        pending: true,
        token: null,
        unavailable: false,
      };
    case "success":
      return {
        identity: action.identity,
        pending: false,
        token: action.token,
        unavailable: false,
      };
    case "unavailable":
      return {
        identity: action.identity,
        pending: false,
        token: null,
        unavailable: true,
      };
  }
}

export function putViewport3DTopologyIndexBundleInCache({
  bundle,
  key,
}: {
  bundle: Viewport3DTopologyIndexBundle;
  key: string;
}): Viewport3DTopologyIndexBundleCacheHandle {
  const previous = topologyIndexBundleCache.get(key);
  if (previous) {
    topologyIndexBundleBuffers.delete(previous.token);
  }
  const token = {};
  const entry: Viewport3DTopologyIndexBundleCacheEntry = {
    bundle,
    estimatedBytes: estimateTopologyIndexBundleBytes(bundle),
    key,
    lastUsedAtMs: now(),
    refCount: 1,
    token,
  };
  topologyIndexBundleBuffers.set(token, bundle);
  topologyIndexBundleCache.set(key, entry);
  evictTopologyIndexBundleCache();
  return createTopologyIndexBundleCacheHandle(entry);
}

export function retainViewport3DTopologyIndexBundleFromCache(
  key: string,
): Viewport3DTopologyIndexBundleCacheHandle | null {
  const entry = topologyIndexBundleCache.get(key);
  if (!entry) return null;
  entry.refCount += 1;
  entry.lastUsedAtMs = now();
  return createTopologyIndexBundleCacheHandle(entry);
}

export function getViewport3DTopologyIndexBundleCacheSnapshotForTests(): Viewport3DTopologyIndexBundleCacheSnapshot {
  const entries = [...topologyIndexBundleCache.values()];
  return {
    entryCount: entries.length,
    estimatedBytes: entries.reduce(
      (total, entry) => total + entry.estimatedBytes,
      0,
    ),
    keys: entries.map((entry) => entry.key),
    retainedEntries: entries.filter((entry) => entry.refCount > 0).length,
  };
}

export function clearViewport3DTopologyIndexBundleCacheForTests(): void {
  for (const entry of topologyIndexBundleCache.values()) {
    topologyIndexBundleBuffers.delete(entry.token);
  }
  topologyIndexBundleCache.clear();
}

export function viewport3DTopologyIndexStateIsCompatible(
  current: Viewport3DTopologyIndexIdentity | null,
  request: Viewport3DTopologyIndexIdentity | null,
): boolean {
  return Boolean(
    current &&
      request &&
      current.topology === request.topology &&
      current.magneticParts === request.magneticParts &&
      current.airboxParts === request.airboxParts &&
      current.magneticSurfacePartsByPartId ===
        request.magneticSurfacePartsByPartId,
  );
}

export function resolveViewport3DTopologyIndexStatus({
  enabled,
  hasCompatibleBundle,
  hasCompatibleUnavailableState,
  hasTopology,
  pendingForCurrentRequest,
}: {
  enabled: boolean;
  hasCompatibleBundle: boolean;
  hasCompatibleUnavailableState: boolean;
  hasTopology: boolean;
  pendingForCurrentRequest: boolean;
}): Viewport3DTopologyIndexBuildStatus {
  if (!enabled || !hasTopology) return "idle";
  if (hasCompatibleBundle) return "ready";
  if (hasCompatibleUnavailableState) return "unavailable";
  if (pendingForCurrentRequest) return "building";
  return "building";
}

export function useViewport3DTopologyIndexBundle({
  airboxParts,
  domainId = "shared-domain",
  enabled,
  magneticParts,
  magneticSurfacePartsByPartId,
  sessionId = "current",
  topology,
  topologyRevision,
}: {
  airboxParts: readonly Viewport3DTopologyIndexPartInput[];
  domainId?: string;
  enabled: boolean;
  magneticParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticSurfacePartsByPartId: ReadonlyMap<
    string,
    readonly Viewport3DTopologyIndexPartInput[]
  >;
  sessionId?: string;
  topology: DecodedTopology | null | undefined;
  topologyRevision?: string | null;
}): Viewport3DTopologyIndexBundleResult {
  const [state, dispatch] = useReducer(
    viewport3DTopologyIndexReducer,
    VIEWPORT_3D_TOPOLOGY_INDEX_INITIAL_STATE,
  );
  const activeBuildIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeTokenRef = useRef<object | null>(null);
  const identity = useMemo<Viewport3DTopologyIndexIdentity | null>(
    () =>
      topology
        ? {
            airboxParts,
            magneticParts,
            magneticSurfacePartsByPartId,
            topology,
          }
        : null,
    [airboxParts, magneticParts, magneticSurfacePartsByPartId, topology],
  );
  const buildReference = useMemo(
    () =>
      createViewport3DTopologyIndexBuildReference({
        domainId,
        sessionId,
        topologyRevision: topologyRevision ?? null,
      }),
    [domainId, sessionId, topologyRevision],
  );
  const compatible = viewport3DTopologyIndexStateIsCompatible(
    state.identity,
    identity,
  );
  const hasCompatibleBundle = compatible && Boolean(state.token);
  const pendingForCurrentRequest = compatible && state.pending;
  const hasCompatibleUnavailableState = compatible && state.unavailable;
  const status = resolveViewport3DTopologyIndexStatus({
    enabled,
    hasCompatibleBundle,
    hasCompatibleUnavailableState,
    hasTopology: Boolean(topology),
    pendingForCurrentRequest,
  });

  useEffect(() => {
    return () => {
      activeBuildIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      releaseTopologyIndexBundleToken(activeTokenRef.current);
      activeTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (enabled && topology && identity) return;

    activeBuildIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    releaseTopologyIndexBundleToken(activeTokenRef.current);
    activeTokenRef.current = null;
    dispatch({ type: "clear" });
  }, [enabled, identity, topology]);

  useEffect(() => {
    if (!enabled || !topology || !identity || status !== "building") {
      return undefined;
    }
    if (pendingForCurrentRequest) {
      return undefined;
    }

    if (buildReference) {
      const cached = retainViewport3DTopologyIndexBundleFromCache(
        buildReference.buildKey,
      );
      if (cached) {
        activeBuildIdRef.current += 1;
        activeControllerRef.current?.abort();
        activeControllerRef.current = null;
        if (activeTokenRef.current === cached.token) {
          cached.release();
        } else {
          releaseTopologyIndexBundleToken(activeTokenRef.current);
          activeTokenRef.current = cached.token;
        }
        dispatch({ identity, token: cached.token, type: "success" });
        return undefined;
      }
    }

    activeBuildIdRef.current += 1;
    activeControllerRef.current?.abort();
    const buildId = activeBuildIdRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    dispatch({ identity, type: "start" });

    const request: Viewport3DTopologyIndexBuildRequest = {
      airboxParts,
      magneticParts,
      magneticSurfacePartsByPartId,
      topology: {
        boundaryFaces: topology.boundaryFaces,
        indices: topology.indices,
        nodeCount: topology.nodeCount,
      },
    };

    void buildViewport3DTopologyIndicesOffMainThread(request, {
      buildKey: buildReference?.buildKey,
      groupKey: buildReference?.groupKey,
      latestWins: true,
      revisionSummary: buildReference?.revisionSummary,
      signal: controller.signal,
    })
      .then((bundle) => {
        if (activeBuildIdRef.current === buildId) {
          const handle = buildReference
            ? putViewport3DTopologyIndexBundleInCache({
                bundle,
                key: buildReference.buildKey,
              })
            : createTopologyIndexBundleHandle(bundle);
          releaseTopologyIndexBundleToken(activeTokenRef.current);
          activeTokenRef.current = handle.token;
          dispatch({ identity, token: handle.token, type: "success" });
        }
      })
      .catch((error) => {
        if (activeBuildIdRef.current !== buildId || isAbortError(error)) {
          return;
        }
        releaseTopologyIndexBundleToken(activeTokenRef.current);
        activeTokenRef.current = null;
        dispatch({ identity, type: "unavailable" });
      })
      .finally(() => {
        if (activeBuildIdRef.current === buildId) {
          activeControllerRef.current = null;
        }
      });

    return undefined;
  }, [
    airboxParts,
    buildReference,
    enabled,
    identity,
    magneticParts,
    magneticSurfacePartsByPartId,
    pendingForCurrentRequest,
    status,
    topology,
  ]);

  return {
    bundle:
      hasCompatibleBundle && state.token
        ? topologyIndexBundleBuffers.get(state.token) ?? null
        : null,
    status,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createTopologyIndexBundleHandle(
  bundle: Viewport3DTopologyIndexBundle,
): Viewport3DTopologyIndexBundleCacheHandle {
  const token = {};
  topologyIndexBundleBuffers.set(token, bundle);
  return {
    bundle,
    release: () => topologyIndexBundleBuffers.delete(token),
    token,
  };
}

function createTopologyIndexBundleCacheHandle(
  entry: Viewport3DTopologyIndexBundleCacheEntry,
): Viewport3DTopologyIndexBundleCacheHandle {
  let released = false;
  return {
    bundle: entry.bundle,
    release: () => {
      if (released) return;
      released = true;
      releaseTopologyIndexBundleToken(entry.token);
    },
    token: entry.token,
  };
}

function releaseTopologyIndexBundleToken(token: object | null): void {
  if (!token) return;
  for (const entry of topologyIndexBundleCache.values()) {
    if (entry.token !== token) continue;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAtMs = now();
    evictTopologyIndexBundleCache();
    return;
  }
  topologyIndexBundleBuffers.delete(token);
}

function evictTopologyIndexBundleCache(): void {
  while (topologyIndexBundleCache.size > TOPOLOGY_INDEX_BUNDLE_CACHE_LIMIT) {
    const evictable = [...topologyIndexBundleCache.values()]
      .filter((entry) => entry.refCount === 0)
      .toSorted((left, right) => left.lastUsedAtMs - right.lastUsedAtMs)[0];
    if (!evictable) return;
    topologyIndexBundleCache.delete(evictable.key);
    topologyIndexBundleBuffers.delete(evictable.token);
  }
}

function estimateTopologyIndexBundleBytes(
  bundle: Viewport3DTopologyIndexBundle,
): number {
  let total =
    (bundle.fallbackSurfaceEdgeIndices?.byteLength ?? 0) +
    bundle.fallbackSurfaceIndices.byteLength +
    bundle.fallbackSurfaceNodeIndices.byteLength +
    bundle.fallbackVolumeEdgeIndices.byteLength;
  for (const indices of bundle.magneticPartsById.values()) {
    total += estimatePreparedPartTopologyIndexBytes(indices);
  }
  for (const indices of bundle.airboxPartsById.values()) {
    total += estimatePreparedPartTopologyIndexBytes(indices);
  }
  return total;
}

function estimatePreparedPartTopologyIndexBytes(
  indices: Viewport3DTopologyIndexBundle["magneticPartsById"] extends Map<
    string,
    infer TIndices
  >
    ? TIndices
    : never,
): number {
  return (
    (indices.edgeIndices?.byteLength ?? 0) +
    (indices.surfaceIndices?.byteLength ?? 0) +
    (indices.surfaceNodeIndices?.byteLength ?? 0) +
    (indices.volumeEdgeIndices?.byteLength ?? 0)
  );
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
