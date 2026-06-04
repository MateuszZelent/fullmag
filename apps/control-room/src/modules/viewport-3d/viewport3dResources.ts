"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_FIELDS_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
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
import { ResourceCache } from "@/kernel/resources/ResourceCache";
import { useResource } from "@/kernel/resources/useResource";

const topologyCache = new ResourceCache<DecodedTopology>({
  maxBytes: 96 * 1024 * 1024,
});
const fieldVectorCache = new ResourceCache<DecodedFieldVector>({
  maxBytes: 128 * 1024 * 1024,
});
const qualityDataCache = new ResourceCache<DecodedMeshQualityData>({
  maxBytes: 48 * 1024 * 1024,
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
  key: string;
  query: FieldVectorQuery;
}

export interface Viewport3DPartFieldVectorRequest {
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
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
  request: (etag?: string | null) => Promise<BinaryResourceResult<TData>>,
  options: { preferCached?: boolean } = {},
): Promise<TData | null> {
  const cached = cache.get(key);
  if (cached && options.preferCached) {
    return cached.data;
  }

  const result = await request(cached?.etag);

  if (result.status === "not-modified") {
    if (!cached) {
      throw new Error(`Binary resource ${key} returned 304 without cache entry`);
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
  const path = DATA_FIELD_VECTOR_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(resolveCanonicalQuantityId(quantityId)),
  );
  const params = new URLSearchParams();
  if (query.component) params.set("component", query.component);
  if (query.max_samples != null) {
    params.set("max_samples", String(query.max_samples));
  }
  if (query.scope_id) params.set("scope_id", query.scope_id);
  if (query.scope_kind) params.set("scope_kind", query.scope_kind);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function resolveViewport3DAirboxFieldVectorQuery(
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
): FieldVectorQuery {
  const query: FieldVectorQuery = {
    ...fieldQuery,
    component: fieldQuery.component ?? "full",
    scope_kind: "airbox",
  };
  delete query.scope_id;
  return query;
}

export function resolveViewport3DAirboxFieldVectorResourceKeys(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
): Map<string, string> {
  if (isMagneticOnlyQuantityId(quantityId)) {
    return new Map();
  }
  const query = resolveViewport3DAirboxFieldVectorQuery(fieldQuery);
  return new Map(
    airboxParts.map((part) => [
      part.id,
      resolveViewport3DFieldVectorResourceKey(quantityId, query),
    ]),
  );
}

export function resolveViewport3DQuantityFieldVectorResourceKeys(
  quantityIds: readonly string[],
): Map<string, string> {
  return new Map(
    [...new Set(quantityIds)]
      .filter((quantityId) => quantityId.trim().length > 0)
      .sort()
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
  quantityQueries: ReadonlyMap<string, FieldVectorQuery>,
): Map<string, Viewport3DQuantityFieldVectorRequest> {
  return new Map(
    Array.from(quantityQueries)
      .filter(([quantityId]) => quantityId.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([quantityId, query]) => [
        quantityId,
        {
          key: resolveViewport3DFieldVectorResourceKey(quantityId, query),
          query,
        },
      ]),
  );
}

export function resolveViewport3DPartFieldVectorResourceRequests(
  partQueries: ReadonlyMap<
    string,
    { quantityId: string; query: FieldVectorQuery }
  >,
): Map<string, Viewport3DPartFieldVectorRequest> {
  return new Map(
    Array.from(partQueries)
      .filter(([, request]) => request.quantityId.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([partId, request]) => {
        const query: FieldVectorQuery = {
          ...request.query,
          component: request.query.component ?? "full",
          scope_id: partId,
          scope_kind: "part",
        };
        return [
          partId,
          {
            key: resolveViewport3DFieldVectorResourceKey(
              request.quantityId,
              query,
            ),
            quantityId: request.quantityId,
            query,
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
        (etag) => api.data.domain.topologyChunked({ etag, signal }),
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
) {
  const { api, resources } = useKernel();
  const component = fieldQuery.component ?? "full";
  const maxSamples = fieldQuery.max_samples ?? null;
  const scopeId = fieldQuery.scope_id ?? null;
  const scopeKind = fieldQuery.scope_kind ?? null;
  const query = useMemo<FieldVectorQuery>(
    () => ({
      component,
      max_samples: maxSamples,
      scope_id: scopeId,
      scope_kind: scopeKind,
    }),
    [component, maxSamples, scopeId, scopeKind],
  );
  const requestKey = useMemo(
    () => resolveViewport3DFieldVectorResourceKey(quantityId, query),
    [quantityId, query],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        fieldVectorCache,
        requestKey,
        (etag) => api.data.fields.vector(quantityId, query, { etag, signal }),
        {
          preferCached: cachedBinaryResourceMatchesRevision(
            fieldVectorCache,
            requestKey,
            resources.getRevision(requestKey),
          ),
        },
      ),
    [api, quantityId, query, requestKey, resources],
  );
  const resolveRevision = useCallback(
    () => fieldVectorCache.peek(requestKey)?.etag ?? null,
    [requestKey],
  );

  const resource = useResource({
    enabled,
    load,
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
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
) {
  const { api, resources } = useKernel();
  const requestKeys = useMemo(
    () =>
      resolveViewport3DAirboxFieldVectorResourceKeys(
        quantityId,
        airboxParts,
        fieldQuery,
      ),
    [airboxParts, fieldQuery, quantityId],
  );
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "airbox",
      requestKeys.values(),
    );
  }, [requestKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const query = resolveViewport3DAirboxFieldVectorQuery(fieldQuery);
      const uniqueKeys = Array.from(new Set(requestKeys.values()));
      const dataByKey = new Map(
        await Promise.all(
          uniqueKeys.map(async (key) => {
            const data = await loadCachedBinaryResource(
              fieldVectorCache,
              key,
              (etag) =>
                api.data.fields.vector(quantityId, query, { etag, signal }),
              {
                preferCached: cachedBinaryResourceMatchesRevision(
                  fieldVectorCache,
                  key,
                  resources.getRevision(key),
                ),
              },
            );
            return [key, data] as const;
          }),
        ),
      );
      const entries = Array.from(requestKeys, ([partId, key]) => [
        partId,
        dataByKey.get(key) ?? null,
      ] as const);

      return new Map(
        entries.filter(
          (entry): entry is readonly [string, DecodedFieldVector] =>
            entry[1] !== null,
        ),
      );
    },
    [api, fieldQuery, quantityId, requestKeys, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requestKeys.values()).map(
      (key) => fieldVectorCache.peek(key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requestKeys]);

  const resource = useResource({
    enabled: enabled && requestKeys.size > 0,
    load,
    resolveRevision,
    resourceKey,
  });
  return {
    ...resource,
    payloadRevision: resolveRevision(),
  };
}

export function useViewport3DQuantityFieldVectors(
  quantitySource: readonly string[] | ReadonlyMap<string, FieldVectorQuery>,
  enabled = true,
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
              query: FULL_FIELD_VECTOR_QUERY,
            },
          ]),
      );
    }

    return resolveViewport3DQuantityFieldVectorResourceRequests(
      quantitySource as ReadonlyMap<string, FieldVectorQuery>,
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
        Array.from(requestKeys, async ([quantityId, request]) => {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            request.key,
            (etag) =>
              api.data.fields.vector(
                quantityId,
                request.query,
                { etag, signal },
              ),
            {
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.key),
              ),
            },
          );
          return [quantityId, data] as const;
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
    enabled: enabled && requestKeys.size > 0,
    load,
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
            (etag) =>
              api.data.fields.vector(
                request.quantityId,
                request.query,
                { etag, signal },
              ),
            {
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.key),
              ),
            },
          );
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
    enabled: enabled && requestKeys.size > 0,
    load,
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
        (etag) => api.meshing.sharedDomain.qualityData({ etag, signal }),
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
