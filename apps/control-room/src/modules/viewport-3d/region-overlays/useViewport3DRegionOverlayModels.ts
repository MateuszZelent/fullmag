"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DecodedTopology } from "@/kernel/api/codecs";
import { recordVisualizationDebugPerformanceMetric } from "@/kernel/performance/visualizationDebugPerformanceProbe";
import { buildViewport3DRegionOverlayJobKey } from "../build-engine/viewport3dBuildJobKeys";
import type {
  RegionMeshOverlayModel,
  RegionMeshOverlayOwnerPart,
  RegionOverlayInput,
  RegionOverlayTheme,
} from "../layers/regionOverlayModel";
import {
  buildViewport3DRegionOverlaysOffMainThread,
} from "./viewport3dRegionOverlayBuildScheduler";

export interface Viewport3DRegionOverlayBuildReferenceInput {
  readonly domainId: string;
  readonly regionSignature: string;
  readonly sessionId: string;
  readonly topologyRevision: string | number | null;
}

export interface Viewport3DRegionOverlayBuildReference {
  readonly buildKey: string;
  readonly groupKey: string;
  readonly revisionSummary: string;
}

export interface Viewport3DRegionOverlayIdentity {
  readonly magneticParts: unknown;
  readonly regions: unknown;
  readonly selectedObjectId: string | null;
  readonly selectedRegionId: string | null;
  readonly regionSignature: string;
  readonly theme: string;
  readonly topology: unknown;
}

export interface Viewport3DRegionOverlayBuildStatusInput {
  readonly enabled: boolean;
  readonly hasCompatibleModels: boolean;
  readonly hasCompatibleTopologyModels: boolean;
  readonly hasCompatibleUnavailableState: boolean;
  readonly hasTopology: boolean;
  readonly pendingForCurrentRequest: boolean;
}

export type Viewport3DRegionOverlayBuildStatus =
  | "disabled"
  | "pending"
  | "ready"
  | "stale-visible"
  | "unavailable";

interface Viewport3DRegionOverlayReducerState {
  readonly identity: Viewport3DRegionOverlayIdentity | null;
  readonly pendingIdentity: Viewport3DRegionOverlayIdentity | null;
  readonly token: object | null;
  readonly unavailableIdentity: Viewport3DRegionOverlayIdentity | null;
}

type Viewport3DRegionOverlayAction =
  | {
      readonly identity: Viewport3DRegionOverlayIdentity;
      readonly preserveToken: boolean;
      readonly type: "start";
    }
  | {
      readonly identity: Viewport3DRegionOverlayIdentity;
      readonly token: object;
      readonly type: "success";
    }
  | {
      readonly identity: Viewport3DRegionOverlayIdentity;
      readonly type: "unavailable";
    }
  | { readonly type: "clear" };

export interface Viewport3DRegionOverlayModelsResult {
  readonly models: readonly RegionMeshOverlayModel[];
  readonly status: Viewport3DRegionOverlayBuildStatus;
}

export interface Viewport3DRegionOverlayModelCacheHandle {
  readonly models: readonly RegionMeshOverlayModel[];
  readonly release: () => void;
  readonly token: object;
}

export interface Viewport3DRegionOverlayModelCacheSnapshot {
  readonly entryCount: number;
  readonly estimatedBytes: number;
  readonly keys: readonly string[];
  readonly retainedEntries: number;
}

interface Viewport3DRegionOverlayModelCacheEntry {
  estimatedBytes: number;
  key: string;
  lastUsedAtMs: number;
  models: readonly RegionMeshOverlayModel[];
  refCount: number;
  token: object;
}

const REGION_OVERLAY_MODEL_CACHE_LIMIT = 16;
export const REGION_OVERLAY_MODEL_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const VIEWPORT_3D_REGION_OVERLAY_INITIAL_STATE: Viewport3DRegionOverlayReducerState =
  {
    identity: null,
    pendingIdentity: null,
    token: null,
    unavailableIdentity: null,
  };

const EMPTY_REGION_OVERLAY_MODELS: readonly RegionMeshOverlayModel[] = [];
const regionOverlayModelBuffers = new WeakMap<
  object,
  readonly RegionMeshOverlayModel[]
>();
const regionOverlayModelCache = new Map<
  string,
  Viewport3DRegionOverlayModelCacheEntry
>();

export function createViewport3DRegionOverlayBuildReference({
  domainId,
  regionSignature,
  sessionId,
  topologyRevision,
}: Viewport3DRegionOverlayBuildReferenceInput): Viewport3DRegionOverlayBuildReference | null {
  if (!topologyRevision) return null;

  const resolvedTopologyRevision = String(topologyRevision);
  const styleRevision = `regions=${regionSignature}`;

  return {
    buildKey: buildViewport3DRegionOverlayJobKey({
      algorithmVersion: 1,
      component: null,
      domainId,
      fieldRevision: null,
      quantityId: null,
      samplingRevision: "region-overlay",
      scopeId: null,
      scopeKind: null,
      sessionId,
      styleRevision,
      targetVisualizationRevision: "region-signature",
      topologyRevision: resolvedTopologyRevision,
    }),
    groupKey: `region-overlay:session=${sessionId}:domain=${domainId}`,
    revisionSummary: [
      `topology=${resolvedTopologyRevision}`,
      styleRevision,
    ].join(" "),
  };
}

export function viewport3DRegionOverlayIdentityIsCompatible(
  previous: Viewport3DRegionOverlayIdentity,
  next: Viewport3DRegionOverlayIdentity,
): boolean {
  return (
    previous.topology === next.topology &&
    previous.magneticParts === next.magneticParts &&
    previous.regions === next.regions &&
    previous.selectedObjectId === next.selectedObjectId &&
    previous.selectedRegionId === next.selectedRegionId &&
    previous.regionSignature === next.regionSignature &&
    previous.theme === next.theme
  );
}

export function viewport3DRegionOverlayTopologyIdentityIsCompatible(
  previous: Viewport3DRegionOverlayIdentity,
  next: Viewport3DRegionOverlayIdentity,
): boolean {
  return (
    previous.topology === next.topology &&
    previous.magneticParts === next.magneticParts &&
    previous.regions === next.regions
  );
}

export function resolveViewport3DRegionOverlayBuildStatus({
  enabled,
  hasCompatibleModels,
  hasCompatibleTopologyModels,
  hasCompatibleUnavailableState,
  hasTopology,
  pendingForCurrentRequest,
}: Viewport3DRegionOverlayBuildStatusInput): Viewport3DRegionOverlayBuildStatus {
  if (!enabled) return "disabled";
  if (!hasTopology) return "unavailable";
  if (pendingForCurrentRequest) {
    return hasCompatibleModels || hasCompatibleTopologyModels
      ? "stale-visible"
      : "pending";
  }
  if (hasCompatibleModels) return "ready";
  if (hasCompatibleUnavailableState) return "unavailable";
  return "pending";
}

export function putViewport3DRegionOverlayModelsInCache({
  key,
  models,
}: {
  key: string;
  models: readonly RegionMeshOverlayModel[];
}): Viewport3DRegionOverlayModelCacheHandle {
  const previous = regionOverlayModelCache.get(key);
  if (previous) {
    regionOverlayModelBuffers.delete(previous.token);
  }
  const token = {};
  const entry: Viewport3DRegionOverlayModelCacheEntry = {
    estimatedBytes: estimateRegionOverlayModelBytes(models),
    key,
    lastUsedAtMs: now(),
    models,
    refCount: 1,
    token,
  };
  regionOverlayModelBuffers.set(token, models);
  regionOverlayModelCache.set(key, entry);
  evictRegionOverlayModelCache();
  return createRegionOverlayModelCacheHandle(entry);
}

export function retainViewport3DRegionOverlayModelsFromCache(
  key: string,
): Viewport3DRegionOverlayModelCacheHandle | null {
  const entry = regionOverlayModelCache.get(key);
  if (!entry) {
    recordVisualizationDebugPerformanceMetric("cacheMisses");
    return null;
  }
  recordVisualizationDebugPerformanceMetric("cacheHits");
  entry.refCount += 1;
  entry.lastUsedAtMs = now();
  return createRegionOverlayModelCacheHandle(entry);
}

export function getViewport3DRegionOverlayModelCacheSnapshotForTests(): Viewport3DRegionOverlayModelCacheSnapshot {
  const entries = [...regionOverlayModelCache.values()];
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

export function clearViewport3DRegionOverlayModelCacheForTests(): void {
  for (const entry of regionOverlayModelCache.values()) {
    regionOverlayModelBuffers.delete(entry.token);
  }
  regionOverlayModelCache.clear();
}

function viewport3DRegionOverlayReducer(
  state: Viewport3DRegionOverlayReducerState,
  action: Viewport3DRegionOverlayAction,
): Viewport3DRegionOverlayReducerState {
  switch (action.type) {
    case "clear":
      return VIEWPORT_3D_REGION_OVERLAY_INITIAL_STATE;
    case "start":
      return {
        identity: action.preserveToken ? state.identity : null,
        pendingIdentity: action.identity,
        token: action.preserveToken ? state.token : null,
        unavailableIdentity: null,
      };
    case "success":
      return {
        identity: action.identity,
        pendingIdentity: null,
        token: action.token,
        unavailableIdentity: null,
      };
    case "unavailable":
      return {
        identity: null,
        pendingIdentity: null,
        token: null,
        unavailableIdentity: action.identity,
      };
  }
}

export function useViewport3DRegionOverlayModels({
  domainId = "shared-domain",
  enabled,
  magneticParts,
  regions,
  selectedObjectId = null,
  selectedRegionId = null,
  sessionId = "current",
  theme = "mocha",
  topology,
  topologyRevision,
}: {
  readonly domainId?: string;
  readonly enabled: boolean;
  readonly magneticParts: readonly RegionMeshOverlayOwnerPart[];
  readonly regions: readonly RegionOverlayInput[];
  readonly selectedObjectId?: string | null;
  readonly selectedRegionId?: string | null;
  readonly sessionId?: string;
  readonly theme?: RegionOverlayTheme;
  readonly topology: DecodedTopology | null | undefined;
  readonly topologyRevision?: string | number | null;
}): Viewport3DRegionOverlayModelsResult {
  const [state, dispatch] = useReducer(
    viewport3DRegionOverlayReducer,
    VIEWPORT_3D_REGION_OVERLAY_INITIAL_STATE,
  );
  const activeBuildIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeTokenRef = useRef<object | null>(null);
  const regionSignature = useMemo(
    () =>
      createViewport3DRegionOverlaySignature({
        regions,
        selectedObjectId,
        selectedRegionId,
        theme,
      }),
    [
      regions,
      selectedObjectId,
      selectedRegionId,
      theme,
    ],
  );
  const identity = useMemo<Viewport3DRegionOverlayIdentity | null>(
    () =>
      topology
        ? {
            magneticParts,
            regions,
            selectedObjectId,
            selectedRegionId,
            regionSignature,
            theme,
            topology,
          }
        : null,
    [
      magneticParts,
      regions,
      selectedObjectId,
      selectedRegionId,
      regionSignature,
      theme,
      topology,
    ],
  );
  const buildReference = useMemo(
    () =>
      createViewport3DRegionOverlayBuildReference({
        domainId,
        regionSignature,
        sessionId,
        topologyRevision: topologyRevision ?? null,
      }),
    [
      domainId,
      regionSignature,
      sessionId,
      topologyRevision,
    ],
  );
  const exactCompatible = Boolean(
    identity &&
      state.identity &&
      viewport3DRegionOverlayIdentityIsCompatible(state.identity, identity),
  );
  const topologyCompatible = Boolean(
    identity &&
      state.identity &&
      viewport3DRegionOverlayTopologyIdentityIsCompatible(
        state.identity,
        identity,
      ),
  );
  const pendingForCurrentRequest = Boolean(
    identity &&
      state.pendingIdentity &&
      viewport3DRegionOverlayIdentityIsCompatible(
        state.pendingIdentity,
        identity,
      ),
  );
  const hasCompatibleModels = exactCompatible && Boolean(state.token);
  const hasCompatibleTopologyModels = topologyCompatible && Boolean(state.token);
  const hasCompatibleUnavailableState = Boolean(
    identity &&
      state.unavailableIdentity &&
      viewport3DRegionOverlayIdentityIsCompatible(
        state.unavailableIdentity,
        identity,
      ),
  );
  const shouldBuild = Boolean(
    enabled &&
      topology &&
      identity &&
      buildReference &&
      !hasCompatibleModels &&
      !pendingForCurrentRequest,
  );

  useEffect(() => {
    return () => {
      activeBuildIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      releaseRegionOverlayModelsToken(activeTokenRef.current);
      activeTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (enabled && topology && identity) return;

    activeBuildIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    releaseRegionOverlayModelsToken(activeTokenRef.current);
    activeTokenRef.current = null;
    dispatch({ type: "clear" });
  }, [enabled, identity, topology]);

  useEffect(() => {
    if (!shouldBuild || !topology || !identity || !buildReference) {
      return undefined;
    }

    const cached = retainViewport3DRegionOverlayModelsFromCache(
      buildReference.buildKey,
    );
    if (cached) {
      activeBuildIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      if (activeTokenRef.current === cached.token) {
        cached.release();
      } else {
        releaseRegionOverlayModelsToken(activeTokenRef.current);
        activeTokenRef.current = cached.token;
      }
      dispatch({ identity, token: cached.token, type: "success" });
      return undefined;
    }

    const preserveToken = hasCompatibleTopologyModels;
    if (!preserveToken) {
      releaseRegionOverlayModelsToken(activeTokenRef.current);
      activeTokenRef.current = null;
    }

    activeBuildIdRef.current += 1;
    activeControllerRef.current?.abort();
    const buildId = activeBuildIdRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    dispatch({ identity, preserveToken, type: "start" });

    void buildViewport3DRegionOverlaysOffMainThread(
      {
        magneticParts,
        regions,
        selectedObjectId,
        selectedRegionId,
        theme,
        topology,
      },
      {
        buildKey: buildReference.buildKey,
        groupKey: buildReference.groupKey,
        latestWins: true,
        revisionSummary: buildReference.revisionSummary,
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (activeBuildIdRef.current !== buildId) return;
        const handle = putViewport3DRegionOverlayModelsInCache({
          key: buildReference.buildKey,
          models: result.models,
        });
        releaseRegionOverlayModelsToken(activeTokenRef.current);
        activeTokenRef.current = handle.token;
        dispatch({ identity, token: handle.token, type: "success" });
      })
      .catch((error) => {
        if (activeBuildIdRef.current !== buildId || isAbortError(error)) {
          return;
        }
        releaseRegionOverlayModelsToken(activeTokenRef.current);
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
    buildReference,
    enabled,
    hasCompatibleTopologyModels,
    identity,
    magneticParts,
    regions,
    selectedObjectId,
    selectedRegionId,
    shouldBuild,
    theme,
    topology,
  ]);

  const models =
    (hasCompatibleModels || hasCompatibleTopologyModels) && state.token
      ? regionOverlayModelBuffers.get(state.token) ?? EMPTY_REGION_OVERLAY_MODELS
      : EMPTY_REGION_OVERLAY_MODELS;

  return {
    models,
    status: resolveViewport3DRegionOverlayBuildStatus({
      enabled,
      hasCompatibleModels,
      hasCompatibleTopologyModels,
      hasCompatibleUnavailableState,
      hasTopology: Boolean(topology),
      pendingForCurrentRequest: pendingForCurrentRequest || shouldBuild,
    }),
  };
}

function createViewport3DRegionOverlaySignature({
  regions,
  selectedObjectId,
  selectedRegionId,
  theme,
}: {
  readonly regions: readonly RegionOverlayInput[];
  readonly selectedObjectId: string | null;
  readonly selectedRegionId: string | null;
  readonly theme: RegionOverlayTheme;
}): string {
  return [
    regions
      .map((region) =>
        [
          nonEmptyString(region.region_id) ?? "unknown-region",
          nonEmptyString(region.owner_object_id) ?? "unknown-object",
          region.enabled === false ? "disabled" : "enabled",
          finiteString(region.priority),
          nonEmptyString(region.name) ?? "",
          meshPartSignature(region.mesh_part_ids),
        ].join(":"),
      )
      .join("|") || "none",
    `selectedObject=${selectedObjectId ?? "none"}`,
    `selectedRegion=${selectedRegionId ?? "none"}`,
    `theme=${theme}`,
  ].join(";");
}

function meshPartSignature(value: unknown): string {
  return Array.isArray(value)
    ? value
        .flatMap((partId) => {
          const id = nonEmptyString(partId);
          return id ? [id] : [];
        })
        .toSorted()
        .join(",")
    : "";
}

function finiteString(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function releaseRegionOverlayModelsToken(token: object | null): void {
  if (!token) return;
  for (const entry of regionOverlayModelCache.values()) {
    if (entry.token !== token) continue;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAtMs = now();
    evictRegionOverlayModelCache();
    return;
  }
  regionOverlayModelBuffers.delete(token);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createRegionOverlayModelCacheHandle(
  entry: Viewport3DRegionOverlayModelCacheEntry,
): Viewport3DRegionOverlayModelCacheHandle {
  let released = false;
  return {
    models: entry.models,
    release: () => {
      if (released) return;
      released = true;
      releaseRegionOverlayModelsToken(entry.token);
    },
    token: entry.token,
  };
}

function evictRegionOverlayModelCache(): void {
  while (
    regionOverlayModelCache.size > REGION_OVERLAY_MODEL_CACHE_LIMIT ||
    regionOverlayModelCacheEstimatedBytes() >
      REGION_OVERLAY_MODEL_CACHE_MAX_BYTES
  ) {
    const evictable = [...regionOverlayModelCache.values()]
      .filter((entry) => entry.refCount === 0)
      .toSorted((left, right) => left.lastUsedAtMs - right.lastUsedAtMs)[0];
    if (!evictable) return;
    regionOverlayModelCache.delete(evictable.key);
    regionOverlayModelBuffers.delete(evictable.token);
    recordVisualizationDebugPerformanceMetric("cacheEvictions");
  }
}

function regionOverlayModelCacheEstimatedBytes(): number {
  return [...regionOverlayModelCache.values()].reduce(
    (total, entry) => total + entry.estimatedBytes,
    0,
  );
}

function estimateRegionOverlayModelBytes(
  models: readonly RegionMeshOverlayModel[],
): number {
  return models.reduce(
    (total, model) =>
      total +
      model.positions.byteLength +
      (model.edgeIndices?.byteLength ?? 0) +
      (model.surfaceEdgeIndices?.byteLength ?? 0) +
      (model.surfaceIndices?.byteLength ?? 0),
    0,
  );
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
