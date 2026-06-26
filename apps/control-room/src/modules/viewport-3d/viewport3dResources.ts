"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_FIELDS_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELD_META_PATH,
  DATA_FIELD_VECTOR_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MODEL_SCENE_PATH,
  MODEL_UNIVERSE_PATH,
} from "@/kernel/api/apiPaths";
import {
  isMagneticOnlyQuantityId,
  resolveCanonicalQuantityId,
} from "@/kernel/api/quantityIds";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type {
  BinaryResourceResult,
  FieldVectorQuery,
  ResourceRevision,
} from "@/kernel/api/apiTypes";
import type {
  DecodedFieldVector,
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";
import { useKernel } from "@/kernel/KernelContext";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";
import { fieldVectorMinRefetchIntervalMs } from "@/kernel/realtime/communicationPolicy";
import { ResourceCache } from "@/kernel/resources/ResourceCache";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useResource } from "@/kernel/resources/useResource";

import {
  buildViewport3DFieldResourceRequestId,
  type Viewport3DFieldResourceRequest,
} from "./model/viewport3DFieldDataPlan";
import { viewport3DFieldUpdateHoldActive } from "./viewport3dFieldUpdateHold";

const topologyCache = new ResourceCache<DecodedTopology>({
  maxBytes: 96 * 1024 * 1024,
});
const fieldVectorCache = new ResourceCache<DecodedFieldVector>({
  maxBytes: 128 * 1024 * 1024,
});
const qualityDataCache = new ResourceCache<DecodedMeshQualityData>({
  maxBytes: 48 * 1024 * 1024,
});
const binaryResourceInflight = new WeakMap<
  ResourceCache<unknown>,
  Map<string, InflightBinaryResource<unknown>>
>();

interface InflightBinaryResource<TData> {
  readonly abortListeners: Map<AbortSignal, () => void>;
  readonly consumerSignals: Set<AbortSignal>;
  readonly controller: AbortController;
  readonly promise: Promise<TData | null>;
}

memoryBudgetRegistry.register("viewport3d.topologyCache", () => {
  const stats = topologyCache.stats();
  return {
    byteLength: stats.byteLength,
    category: "viewport-cache",
    entryCount: stats.entryCount,
    id: "viewport3d.topologyCache",
    label: "Viewport topology cache",
    maxBytes: topologyCache.maxBytes(),
  };
});

memoryBudgetRegistry.register("viewport3d.fieldVectorCache", () => {
  const stats = fieldVectorCache.stats();
  return {
    byteLength: stats.byteLength,
    category: "viewport-cache",
    entryCount: stats.entryCount,
    id: "viewport3d.fieldVectorCache",
    label: "Field vector cache",
    maxBytes: fieldVectorCache.maxBytes(),
  };
});

memoryBudgetRegistry.register("viewport3d.qualityDataCache", () => {
  const stats = qualityDataCache.stats();
  return {
    byteLength: stats.byteLength,
    category: "viewport-cache",
    entryCount: stats.entryCount,
    id: "viewport3d.qualityDataCache",
    label: "Mesh quality cache",
    maxBytes: qualityDataCache.maxBytes(),
  };
});

const VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY = DATA_DOMAIN_META_PATH;
const VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY = DATA_DOMAIN_TOPOLOGY_PATH;
const VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_MANIFEST_PATH;
const VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH;
const VIEWPORT_3D_SCENE_RESOURCE_KEY = MODEL_SCENE_PATH;
const VIEWPORT_3D_UNIVERSE_RESOURCE_KEY = MODEL_UNIVERSE_PATH;
const FULL_FIELD_VECTOR_QUERY: FieldVectorQuery = {
  component: "full",
  scope_kind: "full",
};

export interface Viewport3DQuantityFieldVectorRequest {
  consumers?: readonly string[];
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
  requestId?: string;
}

export interface Viewport3DPartFieldVectorRequest {
  consumers?: readonly string[];
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
  requestId?: string;
}

export interface Viewport3DAirboxFieldVectorRequest {
  consumers?: readonly string[];
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
  requestId?: string;
}

type Viewport3DAirboxFieldVectorSourceRequest =
  | Viewport3DAirboxFieldVectorRequest
  | Viewport3DFieldResourceRequest;

export function viewport3DFieldMetaResourceMatchesQuantity(
  resourceKey: string,
  quantityId: string,
): boolean {
  const fieldMetaPath = DATA_FIELD_META_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(resolveCanonicalQuantityId(quantityId)),
  );
  return (
    resourceKey === fieldMetaPath ||
    resourceKey.startsWith(`${fieldMetaPath}?`) ||
    resourceKey.includes(`#viewport-3d:part-scalar-ranges:${fieldMetaPath}?`) ||
    resourceKey.includes(`|${fieldMetaPath}?`)
  );
}

export function invalidateViewport3DFieldMetaResources(
  resources: ResourceInvalidationController,
  quantityId: string,
  revision: ResourceRevision | null,
): void {
  if (revision === null) return;
  resources.invalidateMatching(
    (resourceKey) =>
      viewport3DFieldMetaResourceMatchesQuantity(resourceKey, quantityId),
    revision,
  );
}

function resolveDomainMetaRevision(meta: { generation_id: number }) {
  return meta.generation_id;
}

function resolveSharedDomainManifestRevision(
  manifest: { revision?: number | string | null } | null,
) {
  return manifest?.revision ?? null;
}

function resolveTopologyRevision() {
  return (
    topologyCache.peek(VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY)?.etag ?? null
  );
}

function resolveQualityDataRevision() {
  return (
    qualityDataCache.peek(VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY)
      ?.etag ?? null
  );
}

function resolveUniverseRevision(universe: { scene_revision: number }) {
  return universe.scene_revision;
}

export function getViewport3DCacheStats() {
  const topologyStats = topologyCache.stats();
  const fieldVectorStats = fieldVectorCache.stats();
  const qualityDataStats = qualityDataCache.stats();

  return {
    byteLength:
      topologyStats.byteLength +
      fieldVectorStats.byteLength +
      qualityDataStats.byteLength,
    entryCount:
      topologyStats.entryCount +
      fieldVectorStats.entryCount +
      qualityDataStats.entryCount,
  };
}

export async function loadCachedBinaryResource<TData>(
  cache: ResourceCache<TData>,
  key: string,
  request: (
    etag?: string | null,
    signal?: AbortSignal,
  ) => Promise<BinaryResourceResult<TData>>,
  options: {
    pauseRequest?: () => boolean;
    preferCached?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<TData | null> {
  const cached = cache.get(key);
  if (cached && options.preferCached) {
    return cached.data;
  }
  if (options.pauseRequest?.()) {
    return cached?.data ?? null;
  }

  const inflight = getInflightBinaryResource<TData>(cache, key);
  if (inflight) {
    retainInflightBinaryResource(inflight, options.signal);
    return inflight.promise;
  }

  const controller = new AbortController();
  const pending = (async () => {
    const result = await request(cached?.etag, controller.signal);

    if (result.status === "not-modified") {
      if (!cached) {
        throw new Error(`Binary resource ${key} returned 304 without cache entry`);
      }
      if (!cache.peek(key)) {
        cache.set(key, cached);
      } else {
        cache.get(key);
      }
      return cached.data;
    }

    if (result.status === "not-applicable") {
      cache.delete(key);
      return null;
    }

    cache.set(key, {
      byteLength: result.byteLength,
      data: result.data,
      etag: result.etag,
    });
    return result.data;
  })();

  const inflightResource: InflightBinaryResource<TData> = {
    abortListeners: new Map<AbortSignal, () => void>(),
    consumerSignals: new Set<AbortSignal>(),
    controller,
    promise: pending,
  };
  retainInflightBinaryResource(inflightResource, options.signal);
  setInflightBinaryResource(cache, key, inflightResource);
  try {
    return await pending;
  } finally {
    clearInflightBinaryResource(cache, key, inflightResource);
  }
}

function getInflightBinaryResource<TData>(
  cache: ResourceCache<TData>,
  key: string,
): InflightBinaryResource<TData> | null {
  const inflight = binaryResourceInflight
    .get(cache as ResourceCache<unknown>)
    ?.get(key);
  return (inflight as InflightBinaryResource<TData> | undefined) ?? null;
}

function setInflightBinaryResource<TData>(
  cache: ResourceCache<TData>,
  key: string,
  inflight: InflightBinaryResource<TData>,
): void {
  const typedCache = cache as ResourceCache<unknown>;
  let cacheInflight = binaryResourceInflight.get(typedCache);
  if (!cacheInflight) {
    cacheInflight = new Map<string, InflightBinaryResource<unknown>>();
    binaryResourceInflight.set(typedCache, cacheInflight);
  }
  cacheInflight.set(key, inflight as InflightBinaryResource<unknown>);
}

function clearInflightBinaryResource<TData>(
  cache: ResourceCache<TData>,
  key: string,
  inflight: InflightBinaryResource<TData>,
): void {
  const typedCache = cache as ResourceCache<unknown>;
  const cacheInflight = binaryResourceInflight.get(typedCache);
  if (!cacheInflight || cacheInflight.get(key) !== inflight) return;
  releaseInflightBinaryResourceListeners(inflight);
  cacheInflight.delete(key);
  if (cacheInflight.size === 0) {
    binaryResourceInflight.delete(typedCache);
  }
}

function retainInflightBinaryResource<TData>(
  inflight: InflightBinaryResource<TData>,
  signal: AbortSignal | undefined,
): void {
  if (!signal || inflight.abortListeners.has(signal)) return;
  if (signal.aborted) {
    if (inflight.consumerSignals.size === 0) {
      inflight.controller.abort();
    }
    return;
  }

  const release = () => {
    inflight.consumerSignals.delete(signal);
    inflight.abortListeners.delete(signal);
    if (inflight.consumerSignals.size === 0) {
      inflight.controller.abort();
    }
  };
  inflight.consumerSignals.add(signal);
  inflight.abortListeners.set(signal, release);
  signal.addEventListener("abort", release, { once: true });
}

function releaseInflightBinaryResourceListeners<TData>(
  inflight: InflightBinaryResource<TData>,
): void {
  for (const [signal, release] of inflight.abortListeners) {
    signal.removeEventListener("abort", release);
  }
  inflight.abortListeners.clear();
  inflight.consumerSignals.clear();
}

export function cachedBinaryResourceMatchesRevision<TData>(
  cache: ResourceCache<TData>,
  key: string,
  revision: ResourceRevision | null,
): boolean {
  const cached = cache.peek(key);
  if (!cached) return false;
  return revision === null || cached.etag === revision;
}

export function resolveViewport3DFieldVectorResourceKey(
  quantityId: string,
  query: FieldVectorQuery = {},
): string {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  const path = DATA_FIELD_VECTOR_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(canonicalQuantityId),
  );
  const params = new URLSearchParams();
  if (query.component) params.set("component", query.component);
  if (query.max_samples != null) {
    params.set("max_samples", String(query.max_samples));
  }
  if (query.scope_id) params.set("scope_id", query.scope_id);
  if (query.scope_kind) params.set("scope_kind", query.scope_kind);
  if (query.snapshot_id) params.set("snapshot_id", query.snapshot_id);
  if (query.stage_id) params.set("stage_id", query.stage_id);
  if (query.view) params.set("view", query.view);
  if (query.phase_rad != null) params.set("phase_rad", String(query.phase_rad));
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function resolveViewport3DFieldVectorRequestResourceKey(
  request: Viewport3DFieldResourceRequest,
): string {
  return resolveViewport3DFieldVectorResourceKey(request.quantityId, request.query);
}

export function resolveViewport3DAirboxFieldVectorQuery(
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
): FieldVectorQuery {
  return {
    ...fieldQuery,
    component: fieldQuery.component ?? "full",
    scope_kind: "airbox",
  };
}

function airboxFieldVectorUnavailable(error: unknown): boolean {
  return error instanceof ControlRoomApiError && error.status === 404;
}

export function resolveViewport3DAirboxFieldVectorResourceKeys(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
): Map<string, string> {
  return new Map(
    Array.from(
      resolveViewport3DAirboxFieldVectorResourceRequests(
        quantityId,
        airboxParts,
        fieldQuery,
      ),
      ([partId, request]) => [partId, request.key],
    ),
  );
}

export function resolveViewport3DAirboxFieldVectorResourceRequests(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
): Map<string, Viewport3DAirboxFieldVectorRequest> {
  if (isMagneticOnlyQuantityId(quantityId)) {
    return new Map();
  }
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  return new Map(
    airboxParts.map((part) => {
      const query = resolveViewport3DAirboxFieldVectorQuery({
        ...fieldQuery,
        scope_id: part.id,
      });
      return [
        part.id,
        {
          key: resolveViewport3DFieldVectorResourceKey(
            canonicalQuantityId,
            query,
          ),
          quantityId: canonicalQuantityId,
          query,
        },
      ];
    }),
  );
}

export function resolveViewport3DQuantityFieldVectorResourceKeys(
  quantityIds: readonly string[],
): Map<string, string> {
  const canonicalQuantityIds = new Set<string>();
  for (const quantityId of quantityIds) {
    const trimmed = quantityId.trim();
    if (trimmed.length > 0) {
      canonicalQuantityIds.add(resolveCanonicalQuantityId(trimmed));
    }
  }
  return new Map(
    Array.from(canonicalQuantityIds)
      .toSorted()
      .map((quantityId) => [
        quantityId,
        resolveViewport3DFieldVectorResourceKey(quantityId, {
          component: "full",
          scope_kind: "full",
        }),
      ]),
  );
}

export function resolveViewport3DQuantityFieldVectorResourceRequests(
  quantityQueries: ReadonlyMap<
    string,
    FieldVectorQuery | Viewport3DFieldResourceRequest
  >,
): Map<string, Viewport3DQuantityFieldVectorRequest> {
  const canonicalQueries = new Map<string, {
    consumers?: readonly string[];
    query: FieldVectorQuery;
    quantityId: string;
    requestId?: string;
  }>();
  for (const [sourceKey, queryOrRequest] of quantityQueries) {
    const quantityId = resolveCanonicalQuantityId(
      "quantityId" in queryOrRequest ? queryOrRequest.quantityId : sourceKey,
    );
    if (!quantityId) continue;
    const requestMetadata = viewport3DFieldResourceRequestMetadata(queryOrRequest);
    const query = viewport3DFieldResourceRequestQuery(queryOrRequest);
    const requestId =
      requestMetadata?.requestId ??
      buildViewport3DFieldResourceRequestId(quantityId, query);
    canonicalQueries.set(requestId, {
      ...(requestMetadata?.consumers
        ? { consumers: requestMetadata.consumers }
        : {}),
      query,
      quantityId,
      requestId,
    });
  }
  return new Map(
    Array.from(canonicalQueries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([requestId, request]) => [
        requestId,
        {
          ...(request.consumers ? { consumers: request.consumers } : {}),
          key: resolveViewport3DFieldVectorResourceKey(
            request.quantityId,
            request.query,
          ),
          quantityId: request.quantityId,
          query: request.query,
          ...(request.requestId ? { requestId: request.requestId } : {}),
        },
      ]),
  );
}

function viewport3DFieldResourceRequestQuery(
  queryOrRequest: FieldVectorQuery | Viewport3DFieldResourceRequest,
): FieldVectorQuery {
  return "requestId" in queryOrRequest ? queryOrRequest.query : queryOrRequest;
}

function viewport3DFieldResourceRequestMetadata(
  queryOrRequest:
    | FieldVectorQuery
    | Viewport3DFieldResourceRequest
    | { quantityId: string; query: FieldVectorQuery },
): Pick<Viewport3DFieldResourceRequest, "consumers" | "requestId"> | null {
  return "requestId" in queryOrRequest && "consumers" in queryOrRequest
    ? {
        consumers: queryOrRequest.consumers,
        requestId: queryOrRequest.requestId,
      }
    : null;
}

export function resolveViewport3DPartFieldVectorResourceRequests(
  partQueries: ReadonlyMap<
    string,
    { quantityId: string; query: FieldVectorQuery } | Viewport3DFieldResourceRequest
  >,
): Map<string, Viewport3DPartFieldVectorRequest> {
  return new Map(
    Array.from(partQueries)
      .filter(([, request]) => request.quantityId.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([partId, request]) => {
        const quantityId = resolveCanonicalQuantityId(
          request.quantityId.trim(),
        );
        const requestMetadata = viewport3DFieldResourceRequestMetadata(request);
        const scopeId = request.query.scope_id ?? partId;
        const query: FieldVectorQuery = {
          ...request.query,
          component: request.query.component ?? "full",
          scope_id: scopeId,
          scope_kind: request.query.scope_id
            ? request.query.scope_kind ?? "part"
            : "part",
        };
        return [
          partId,
          {
            ...(requestMetadata?.consumers
              ? { consumers: requestMetadata.consumers }
              : {}),
            key: resolveViewport3DFieldVectorResourceKey(
              quantityId,
              query,
            ),
            quantityId,
            query,
            ...(requestMetadata?.requestId
              ? { requestId: requestMetadata.requestId }
              : {}),
          },
        ];
      }),
  );
}

function resolveViewport3DFieldVectorCollectionResourceKey(
  kind: "airbox" | "part" | "quantity",
  resourceKeys: Iterable<string>,
): string {
  const suffix = Array.from(resourceKeys).join("|");
  return suffix
    ? `${DATA_FIELDS_PATH}#viewport-3d:${kind}-field-vectors:${suffix}`
    : `${DATA_FIELDS_PATH}#viewport-3d:${kind}-field-vectors:none`;
}

export function useViewport3DDomainMeta() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.data.domain.meta({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveDomainMetaRevision,
    resourceKey: VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY,
  });
}

export function useViewport3DDomainTopology() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        topologyCache,
        VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY,
        (etag, requestSignal) =>
          api.data.domain.topologyChunked({ etag, signal: requestSignal }),
        { signal },
      ),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveTopologyRevision,
    resourceKey: VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY,
  });
}

export function useViewport3DFieldVector(
  quantityId: string,
  fieldQuery: FieldVectorQuery = {},
  enabled = true,
  options: { pauseLoad?: boolean } = {},
) {
  const component = fieldQuery.component ?? "full";
  const maxSamples = fieldQuery.max_samples ?? null;
  const phaseRad = fieldQuery.phase_rad ?? null;
  const scopeId = fieldQuery.scope_id ?? null;
  const scopeKind = fieldQuery.scope_kind ?? null;
  const snapshotId = fieldQuery.snapshot_id ?? null;
  const stageId = fieldQuery.stage_id ?? null;
  const view = fieldQuery.view ?? null;
  const query = useMemo<FieldVectorQuery>(
    () => ({
      component,
      max_samples: maxSamples,
      phase_rad: phaseRad,
      scope_id: scopeId,
      scope_kind: scopeKind,
      snapshot_id: snapshotId,
      stage_id: stageId,
      view,
    }),
    [component, maxSamples, phaseRad, scopeId, scopeKind, snapshotId, stageId, view],
  );
  const request = useMemo<Viewport3DFieldResourceRequest>(
    () => ({
      consumers: ["legacy-field-vector-hook"],
      quantityId,
      query,
      requestId: buildViewport3DFieldResourceRequestId(quantityId, query),
    }),
    [quantityId, query],
  );
  return useViewport3DFieldVectorRequest(request, enabled, options);
}

export function useViewport3DFieldVectorRequest(
  request: Viewport3DFieldResourceRequest,
  enabled = true,
  options: { pauseLoad?: boolean } = {},
) {
  const { api, resources } = useKernel();
  const quantityId = request.quantityId;
  const query = request.query;
  const requestKey = useMemo(
    () => resolveViewport3DFieldVectorRequestResourceKey(request),
    [request],
  );
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const data = await loadCachedBinaryResource(
        fieldVectorCache,
        requestKey,
        (etag, requestSignal) =>
          api.data.fields.vector(quantityId, query, {
            etag,
            signal: requestSignal,
          }),
        {
          pauseRequest: viewport3DFieldUpdateHoldActive,
          preferCached: cachedBinaryResourceMatchesRevision(
            fieldVectorCache,
            requestKey,
            resources.getRevision(requestKey),
          ),
          signal,
        },
      );
      if (data !== null) {
        invalidateViewport3DFieldMetaResources(
          resources,
          quantityId,
          fieldVectorCache.peek(requestKey)?.etag ?? null,
        );
      }
      return data;
    },
    [api, quantityId, query, requestKey, resources],
  );
  const resolveRevision = useCallback(
    () => fieldVectorCache.peek(requestKey)?.etag ?? null,
    [requestKey],
  );

  const resource = useResource({
    abortStaleInflight: true,
    enabled,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    resolveRevision,
    resourceKey: requestKey,
  });
  return {
    ...resource,
    payloadRevision: resolveRevision(),
  };
}

export function useViewport3DAirboxFieldVectors(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  enabled = true,
  fieldSource:
    | FieldVectorQuery
    | ReadonlyMap<string, Viewport3DAirboxFieldVectorSourceRequest> =
    FULL_FIELD_VECTOR_QUERY,
  options: { pauseLoad?: boolean } = {},
) {
  const { api, resources } = useKernel();
  const requests = useMemo(
    () => {
      if (isViewport3DAirboxFieldVectorRequestMap(fieldSource)) {
        return new Map(
          Array.from(fieldSource, ([partId, request]) => [
            partId,
            normalizeViewport3DAirboxFieldVectorRequest(request),
          ]),
        );
      }
      return resolveViewport3DAirboxFieldVectorResourceRequests(
        quantityId,
        airboxParts,
        fieldSource,
      );
    },
    [airboxParts, fieldSource, quantityId],
  );
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "airbox",
      Array.from(requests.values(), (request) => request.key),
    );
  }, [requests]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const uniqueRequests = Array.from(
        new Map(
          Array.from(requests.values(), (request) => [request.key, request]),
        ).values(),
      );
      const dataByKey = new Map(
        await Promise.all(
          uniqueRequests.map(async (request) => {
            const data = await loadCachedBinaryResource(
              fieldVectorCache,
              request.key,
              (etag, requestSignal) =>
                api.data.fields.vector(request.quantityId, request.query, {
                  etag,
                  signal: requestSignal,
                }),
              {
                pauseRequest: viewport3DFieldUpdateHoldActive,
                preferCached: cachedBinaryResourceMatchesRevision(
                  fieldVectorCache,
                  request.key,
                  resources.getRevision(request.key),
                ),
                signal,
              },
            ).catch((error: unknown) => {
              if (airboxFieldVectorUnavailable(error)) {
                return null;
              }
              throw error;
            });
            if (data !== null) {
              invalidateViewport3DFieldMetaResources(
                resources,
                request.quantityId,
                fieldVectorCache.peek(request.key)?.etag ?? null,
              );
            }
            return [request.key, data] as const;
          }),
        ),
      );
      const entries = Array.from(requests, ([partId, request]) => [
        partId,
        dataByKey.get(request.key) ?? null,
      ] as const);

      return new Map(
        entries.filter(
          (entry): entry is readonly [string, DecodedFieldVector] =>
            entry[1] !== null,
        ),
      );
    },
    [api, requests, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requests.values()).map(
      (request) => fieldVectorCache.peek(request.key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requests]);

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && requests.size > 0,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    resolveRevision,
    resourceKey,
  });
  return {
    ...resource,
    payloadRevision: resolveRevision(),
  };
}

function isViewport3DAirboxFieldVectorRequestMap(
  value:
    | FieldVectorQuery
    | ReadonlyMap<string, Viewport3DAirboxFieldVectorSourceRequest>,
): value is ReadonlyMap<string, Viewport3DAirboxFieldVectorSourceRequest> {
  return typeof (value as { entries?: unknown }).entries === "function";
}

function normalizeViewport3DAirboxFieldVectorRequest(
  request: Viewport3DAirboxFieldVectorSourceRequest,
): Viewport3DAirboxFieldVectorRequest {
  if ("key" in request) return request;
  return {
    consumers: request.consumers,
    key: resolveViewport3DFieldVectorRequestResourceKey(request),
    quantityId: request.quantityId,
    query: request.query,
    requestId: request.requestId,
  };
}

export function useViewport3DQuantityFieldVectors(
  quantitySource:
    | readonly string[]
    | ReadonlyMap<string, FieldVectorQuery | Viewport3DFieldResourceRequest>,
  enabled = true,
  options: { pauseLoad?: boolean } = {},
) {
  const { api, resources } = useKernel();
  const requestKeys = useMemo(() => {
    if (Array.isArray(quantitySource)) {
      const quantityIds = quantitySource as readonly string[];
      return new Map(
        Array.from(resolveViewport3DQuantityFieldVectorResourceKeys(quantityIds))
          .map(([quantityId, key]) => [
            quantityId,
            {
              key,
              quantityId,
              query: FULL_FIELD_VECTOR_QUERY,
            },
          ]),
      );
    }

    return resolveViewport3DQuantityFieldVectorResourceRequests(
      quantitySource as ReadonlyMap<
        string,
        FieldVectorQuery | Viewport3DFieldResourceRequest
      >,
    );
  }, [quantitySource]);
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "quantity",
      Array.from(requestKeys.values(), (request) => request.key),
    );
  }, [requestKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries = await Promise.all(
        Array.from(requestKeys, async ([requestId, request]) => {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            request.key,
            (etag, requestSignal) =>
              api.data.fields.vector(
                request.quantityId,
                request.query,
                { etag, signal: requestSignal },
              ),
            {
              pauseRequest: viewport3DFieldUpdateHoldActive,
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.key),
              ),
              signal,
            },
          );
          if (data !== null) {
            invalidateViewport3DFieldMetaResources(
              resources,
              request.quantityId,
              fieldVectorCache.peek(request.key)?.etag ?? null,
            );
          }
          return [requestId, data] as const;
        }),
      );

      return new Map(
        entries.filter(
          (entry): entry is readonly [string, DecodedFieldVector] =>
            entry[1] !== null,
        ),
      );
    },
    [api, requestKeys, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requestKeys.values()).map(
      (request) => fieldVectorCache.peek(request.key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requestKeys]);

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && requestKeys.size > 0,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    resolveRevision,
    resourceKey,
  });
  return {
    ...resource,
    payloadRevision: resolveRevision(),
  };
}

export function useViewport3DPartFieldVectors(
  partQueries: ReadonlyMap<
    string,
    { quantityId: string; query: FieldVectorQuery }
  >,
  enabled = true,
  options: { pauseLoad?: boolean } = {},
) {
  const { api, resources } = useKernel();
  const requestKeys = useMemo(
    () => resolveViewport3DPartFieldVectorResourceRequests(partQueries),
    [partQueries],
  );
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "part",
      Array.from(requestKeys.values(), (request) => request.key),
    );
  }, [requestKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries = await Promise.all(
        Array.from(requestKeys, async ([partId, request]) => {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            request.key,
            (etag, requestSignal) =>
              api.data.fields.vector(
                request.quantityId,
                request.query,
                { etag, signal: requestSignal },
              ),
            {
              pauseRequest: viewport3DFieldUpdateHoldActive,
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.key),
              ),
              signal,
            },
          );
          if (data !== null) {
            invalidateViewport3DFieldMetaResources(
              resources,
              request.quantityId,
              fieldVectorCache.peek(request.key)?.etag ?? null,
            );
          }
          return [partId, data] as const;
        }),
      );

      return new Map(
        entries.filter(
          (entry): entry is readonly [string, DecodedFieldVector] =>
            entry[1] !== null,
        ),
      );
    },
    [api, requestKeys, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requestKeys.values()).map(
      (request) => fieldVectorCache.peek(request.key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requestKeys]);

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && requestKeys.size > 0,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    resolveRevision,
    resourceKey,
  });
  return {
    ...resource,
    payloadRevision: resolveRevision(),
  };
}

export function useViewport3DMeshQualityData(enabled = true) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        qualityDataCache,
        VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
        (etag, requestSignal) =>
          api.meshing.sharedDomain.qualityData({
            etag,
            signal: requestSignal,
          }),
        { signal },
      ),
    [api],
  );

  return useResource({
    enabled,
    load,
    resolveRevision: resolveQualityDataRevision,
    resourceKey: VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
  });
}

export function useViewport3DSharedDomainManifest() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomainManifest({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveSharedDomainManifestRevision,
    resourceKey: VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY,
  });
}

export function useViewport3DScene() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.scene({ signal }),
    [api],
  );

  return useResource({
    load,
    resourceKey: VIEWPORT_3D_SCENE_RESOURCE_KEY,
  });
}

export function useViewport3DUniverse() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.universe({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveUniverseRevision,
    resourceKey: VIEWPORT_3D_UNIVERSE_RESOURCE_KEY,
  });
}
